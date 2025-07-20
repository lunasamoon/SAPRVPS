// Standalone server for Docker deployment  
// Removes Replit-specific dependencies and uses standard Node.js patterns

const express = require('express');
const { createServer } = require('http');
const path = require('path');
const fs = require('fs');
const pg = require('pg');
const multer = require('multer');

// __dirname is already available in CommonJS modules

// Simple ID generator (fallback if nanoid fails)
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Initialize dependencies
let ffmpeg, nanoid;

function initializeDependencies() {
  // Try to load fluent-ffmpeg for video duration detection
  try {
    ffmpeg = require('fluent-ffmpeg');
  } catch (error) {
    console.log('fluent-ffmpeg not available, duration detection disabled');
  }

  try {
    const nanoidModule = require('nanoid');
    nanoid = nanoidModule.nanoid;
  } catch (error) {
    console.log('Using fallback ID generator');
    nanoid = generateId;
  }
}

const { Pool } = pg;

const app = express();
const server = createServer(app);
const port = process.env.STANDALONE_PORT || 3000;

// Basic middleware
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// Request logging middleware (similar to original)
app.use((req, res, next) => {
  const start = Date.now();
  const originalJson = res.json;
  let capturedJsonResponse;

  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalJson.apply(res, [bodyJson, ...args]);
  };

  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path.startsWith('/api')) {
      let logLine = `${req.method} ${req.path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + '…';
      }
      console.log(logLine);
    }
  });

  next();
});

// Database connection
let db;
try {
  const connectionConfig = {
    connectionString: process.env.DATABASE_URL,
  };
  
  // Disable SSL for local/Docker connections
  if (process.env.DATABASE_URL?.includes('localhost') || 
      process.env.DATABASE_URL?.includes('127.0.0.1') ||
      process.env.DATABASE_URL?.includes('db:')) {
    connectionConfig.ssl = false;
  } else {
    connectionConfig.ssl = { rejectUnauthorized: false };
  }
  
  db = new Pool(connectionConfig);
  console.log('Database connection established');
} catch (error) {
  console.error('Database connection failed:', error);
}

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${nanoid()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

// Helper function to get video duration using FFmpeg
async function getVideoDuration(filePath) {
  if (!ffmpeg) {
    return '00:00'; // Fallback when ffmpeg is not available
  }
  
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.error('Error getting video duration:', err);
        resolve('00:00');
        return;
      }
      
      const duration = metadata.format.duration;
      if (!duration) {
        resolve('00:00');
        return;
      }
      
      const minutes = Math.floor(duration / 60);
      const seconds = Math.floor(duration % 60);
      resolve(`${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`);
    });
  });
}

const upload = multer({ 
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['video/mp4', 'video/avi', 'video/mov', 'video/mkv'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only video files are allowed.'));
    }
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    database: db ? 'connected' : 'disconnected'
  });
});

// API Routes
app.get('/api/videos', async (req, res) => {
  try {
    if (!db) throw new Error('Database not available');
    const result = await db.query('SELECT * FROM videos ORDER BY playlist_order ASC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching videos:', error);
    res.status(500).json({ error: 'Failed to fetch videos' });
  }
});

app.post('/api/videos', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    const { title } = req.body;
    const filename = req.file.filename;
    const fileSize = req.file.size;
    
    // Get next playlist order
    const orderResult = await db.query('SELECT COALESCE(MAX("playlistOrder"), 0) + 1 as "nextOrder" FROM videos');
    const playlistOrder = orderResult.rows[0].nextOrder;

    // Get video duration using FFmpeg
    const filePath = path.join(__dirname, 'uploads', filename);
    const duration = await getVideoDuration(filePath);

    // Insert video record
    const result = await db.query(
      'INSERT INTO videos (title, filename, "fileSize", duration, "playlistOrder", "uploadedAt") VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *',
      [title || 'Untitled Video', filename, fileSize, duration, playlistOrder]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error uploading video:', error);
    res.status(500).json({ error: 'Failed to upload video' });
  }
});

app.put('/api/videos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const result = await db.query(
      'UPDATE videos SET title = $1 WHERE id = $2 RETURNING *',
      [title, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Video not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating video:', error);
    res.status(500).json({ error: 'Failed to update video' });
  }
});

app.delete('/api/videos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get video info first
    const videoResult = await db.query('SELECT * FROM videos WHERE id = $1', [id]);
    if (videoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const video = videoResult.rows[0];
    
    // Delete file
    const filePath = path.join(__dirname, 'uploads', video.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Delete from database
    await db.query('DELETE FROM videos WHERE id = $1', [id]);
    
    res.json({ message: 'Video deleted successfully' });
  } catch (error) {
    console.error('Error deleting video:', error);
    res.status(500).json({ error: 'Failed to delete video' });
  }
});

app.get('/api/stream-status', async (req, res) => {
  try {
    if (!db) throw new Error('Database not available');
    const result = await db.query('SELECT * FROM "streamStatus" ORDER BY id DESC LIMIT 1');
    
    if (result.rows.length === 0) {
      // Create default status
      const defaultStatus = await db.query(
        'INSERT INTO "streamStatus" (status, "viewerCount", uptime, "loopPlaylist") VALUES ($1, $2, $3, $4) RETURNING *',
        ['offline', 0, '00:00:00', false]
      );
      res.json(defaultStatus.rows[0]);
    } else {
      res.json(result.rows[0]);
    }
  } catch (error) {
    console.error('Error fetching stream status:', error);
    res.status(500).json({ error: 'Failed to fetch stream status' });
  }
});

app.get('/api/stream-config', async (req, res) => {
  try {
    if (!db) throw new Error('Database not available');
    const result = await db.query('SELECT * FROM "streamConfigs" WHERE "isActive" = true ORDER BY id DESC LIMIT 1');
    
    if (result.rows.length === 0) {
      res.json({
        platform: 'youtube',
        streamKey: '',
        resolution: '1920x1080',
        framerate: 30,
        bitrate: 2500,
        audioQuality: 128
      });
    } else {
      res.json(result.rows[0]);
    }
  } catch (error) {
    console.error('Error fetching stream config:', error);
    res.status(500).json({ error: 'Failed to fetch stream config' });
  }
});

app.post('/api/stream-config', async (req, res) => {
  try {
    const { platform, streamKey, rtmpUrl, resolution, framerate, bitrate, audioQuality } = req.body;
    
    // Deactivate existing configs
    await db.query('UPDATE "streamConfigs" SET "isActive" = false');
    
    // Insert new config
    const result = await db.query(
      'INSERT INTO "streamConfigs" (platform, "streamKey", "rtmpUrl", resolution, framerate, bitrate, "audioQuality", "isActive") VALUES ($1, $2, $3, $4, $5, $6, $7, true) RETURNING *',
      [platform, streamKey, rtmpUrl, resolution, framerate, bitrate, audioQuality]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error saving stream config:', error);
    res.status(500).json({ error: 'Failed to save stream config' });
  }
});

app.get('/api/system-config', async (req, res) => {
  try {
    if (!db) throw new Error('Database not available');
    const result = await db.query('SELECT * FROM "systemConfigs" ORDER BY id DESC LIMIT 1');
    
    if (result.rows.length === 0) {
      // Create default config
      const defaultConfig = await db.query(
        'INSERT INTO "systemConfigs" ("rtmpPort", "webPort", "dbHost", "dbPort", "dbName", "useExternalDb") VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [1935, 5000, 'localhost', 5432, 'streaming_db', false]
      );
      res.json(defaultConfig.rows[0]);
    } else {
      res.json(result.rows[0]);
    }
  } catch (error) {
    console.error('Error fetching system config:', error);
    res.status(500).json({ error: 'Failed to fetch system config' });
  }
});

// Enhanced streaming endpoints with RTMP manager integration
app.post('/api/stream/start', async (req, res) => {
  try {
    // Get current stream status to check for selected video
    const statusResult = await db.query('SELECT * FROM "streamStatus" ORDER BY id DESC LIMIT 1');
    const streamStatus = statusResult.rows[0];
    
    if (!streamStatus?.currentVideoId) {
      return res.status(400).json({ error: 'No video selected for streaming' });
    }

    // Get video info
    const videoResult = await db.query('SELECT * FROM videos WHERE id = $1', [streamStatus.currentVideoId]);
    if (videoResult.rows.length === 0) {
      return res.status(400).json({ error: 'Selected video not found' });
    }

    // Get stream configuration
    const configResult = await db.query('SELECT * FROM "streamConfigs" WHERE "isActive" = true ORDER BY id DESC LIMIT 1');
    const streamConfig = configResult.rows[0];
    
    if (!streamConfig) {
      return res.status(400).json({ error: 'Stream configuration not found' });
    }

    // Build streaming configuration
    const rtmpConfig = {
      platform: streamConfig.platform,
      streamKey: streamConfig.streamKey,
      rtmpUrl: streamConfig.rtmpUrl,
      resolution: streamConfig.resolution,
      framerate: streamConfig.framerate,
      bitrate: streamConfig.bitrate,
    };

    // Set loop enabled based on current status
    rtmpManager.setLoopEnabled(streamStatus?.loopPlaylist || false);

    // Start stream with RTMP manager
    const started = await rtmpManager.startStream(streamStatus.currentVideoId, rtmpConfig);
    
    if (!started) {
      return res.status(500).json({ error: 'Failed to start RTMP stream' });
    }

    // Update database status
    await db.query('UPDATE "streamStatus" SET status = $1, "startedAt" = NOW() WHERE id = (SELECT MAX(id) FROM "streamStatus")', ['live']);
    
    const updatedStatus = await db.query('SELECT * FROM "streamStatus" ORDER BY id DESC LIMIT 1');
    res.json(updatedStatus.rows[0]);
  } catch (error) {
    console.error('Error starting stream:', error);
    res.status(500).json({ error: 'Failed to start stream' });
  }
});

app.post('/api/stream/stop', async (req, res) => {
  try {
    // Stop all RTMP streams
    await rtmpManager.stopAllStreams();
    
    // Disable loop when stopping stream
    rtmpManager.setLoopEnabled(false);
    
    // Update database
    await db.query('UPDATE "streamStatus" SET status = $1, "currentVideoId" = NULL, "startedAt" = NULL, "loopPlaylist" = false WHERE id = (SELECT MAX(id) FROM "streamStatus")', ['offline']);
    
    const updatedStatus = await db.query('SELECT * FROM "streamStatus" ORDER BY id DESC LIMIT 1');
    res.json(updatedStatus.rows[0]);
  } catch (error) {
    console.error('Error stopping stream:', error);
    res.status(500).json({ error: 'Failed to stop stream' });
  }
});

app.post('/api/stream/set-current', async (req, res) => {
  try {
    const { videoId } = req.body;
    
    if (!videoId) {
      return res.status(400).json({ error: 'Video ID is required' });
    }

    // Verify video exists
    const videoResult = await db.query('SELECT * FROM videos WHERE id = $1', [videoId]);
    if (videoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    // Get current status for preserving other fields
    const currentStatus = await db.query('SELECT * FROM "streamStatus" ORDER BY id DESC LIMIT 1');
    const status = currentStatus.rows[0];
    
    // Update stream status with current video
    await db.query(
      'UPDATE "streamStatus" SET "currentVideoId" = $1 WHERE id = (SELECT MAX(id) FROM "streamStatus")',
      [videoId]
    );
    
    const updatedStatus = await db.query('SELECT * FROM "streamStatus" ORDER BY id DESC LIMIT 1');
    res.json(updatedStatus.rows[0]);
  } catch (error) {
    console.error('Error setting current video:', error);
    res.status(500).json({ error: 'Failed to set current video' });
  }
});

app.post('/api/stream/restart', async (req, res) => {
  try {
    // Get current stream status to check for selected video
    const statusResult = await db.query('SELECT * FROM "streamStatus" ORDER BY id DESC LIMIT 1');
    const streamStatus = statusResult.rows[0];
    
    if (!streamStatus?.currentVideoId) {
      return res.status(400).json({ error: 'No video selected for streaming' });
    }

    // Stop all RTMP streams first
    await rtmpManager.stopAllStreams();
    
    // Update status to offline briefly
    await db.query('UPDATE "streamStatus" SET status = $1, "startedAt" = NULL WHERE id = (SELECT MAX(id) FROM "streamStatus")', ['offline']);
    
    // Restart after brief delay
    setTimeout(async () => {
      try {
        // Get stream configuration
        const configResult = await db.query('SELECT * FROM "streamConfigs" WHERE "isActive" = true ORDER BY id DESC LIMIT 1');
        const streamConfig = configResult.rows[0];
        
        if (streamConfig) {
          const rtmpConfig = {
            platform: streamConfig.platform,
            streamKey: streamConfig.streamKey,
            rtmpUrl: streamConfig.rtmpUrl,
            resolution: streamConfig.resolution,
            framerate: streamConfig.framerate,
            bitrate: streamConfig.bitrate,
          };

          // Restart the stream
          const started = await rtmpManager.startStream(streamStatus.currentVideoId, rtmpConfig);
          
          if (started) {
            await db.query('UPDATE "streamStatus" SET status = $1, "startedAt" = NOW() WHERE id = (SELECT MAX(id) FROM "streamStatus")', ['live']);
          }
        }
      } catch (restartError) {
        console.error('Error during stream restart:', restartError);
        await db.query('UPDATE "streamStatus" SET status = $1 WHERE id = (SELECT MAX(id) FROM "streamStatus")', ['error']);
      }
    }, 2000);
    
    const updatedStatus = await db.query('SELECT * FROM "streamStatus" ORDER BY id DESC LIMIT 1');
    res.json(updatedStatus.rows[0]);
  } catch (error) {
    console.error('Error restarting stream:', error);
    res.status(500).json({ error: 'Failed to restart stream' });
  }
});

app.post('/api/stream/loop/enable', async (req, res) => {
  try {
    await db.query('UPDATE "streamStatus" SET "loopPlaylist" = true');
    rtmpManager.setLoopEnabled(true);
    res.json({ message: '24x7 loop enabled' });
  } catch (error) {
    console.error('Error enabling loop:', error);
    res.status(500).json({ error: 'Failed to enable loop' });
  }
});

app.post('/api/stream/loop/disable', async (req, res) => {
  try {
    await db.query('UPDATE "streamStatus" SET "loopPlaylist" = false');
    rtmpManager.setLoopEnabled(false);
    res.json({ message: '24x7 loop disabled' });
  } catch (error) {
    console.error('Error disabling loop:', error);
    res.status(500).json({ error: 'Failed to disable loop' });
  }
});

app.get('/api/stream/loop/status', async (req, res) => {
  try {
    const result = await db.query('SELECT "loopPlaylist" FROM "streamStatus" ORDER BY id DESC LIMIT 1');
    const loopEnabled = result.rows[0]?.loopPlaylist || false;
    
    res.json({ 
      loopEnabled,
      rtmpLoopEnabled: rtmpManager.isLoopEnabled()
    });
  } catch (error) {
    console.error('Error getting loop status:', error);
    res.status(500).json({ error: 'Failed to get loop status' });
  }
});

// FFmpeg test endpoint  
app.post('/api/stream/test', async (req, res) => {
  try {
    // Test FFmpeg availability
    let spawn;
    try {
      const { spawn: spawnFunc } = require('child_process');
      spawn = spawnFunc;
    } catch (error) {
      return res.status(400).json({ 
        message: 'child_process module not available in this environment',
        error: 'streaming not supported'
      });
    }

    // Try to execute ffmpeg -version
    const testProcess = spawn('ffmpeg', ['-version']);
    let output = '';
    let errorOutput = '';

    testProcess.stdout?.on('data', (data) => {
      output += data.toString();
    });

    testProcess.stderr?.on('data', (data) => {
      errorOutput += data.toString();
    });

    testProcess.on('close', (code) => {
      if (code === 0 && output.includes('ffmpeg version')) {
        const versionMatch = output.match(/ffmpeg version (\S+)/);
        const version = versionMatch ? versionMatch[1] : 'unknown';
        res.json({ 
          message: `FFmpeg ${version} is available and working`,
          version: version,
          success: true
        });
      } else {
        res.status(400).json({ 
          message: 'FFmpeg is not available or not working properly',
          error: errorOutput || 'FFmpeg test failed',
          success: false
        });
      }
    });

    testProcess.on('error', (error) => {
      res.status(400).json({ 
        message: 'FFmpeg is not installed or not accessible',
        error: error.message,
        success: false
      });
    });

    // Timeout after 10 seconds
    setTimeout(() => {
      testProcess.kill();
      if (!res.headersSent) {
        res.status(408).json({ 
          message: 'FFmpeg test timed out',
          error: 'Test took too long to complete',
          success: false
        });
      }
    }, 10000);

  } catch (error) {
    console.error('FFmpeg test error:', error);
    res.status(500).json({ 
      message: 'Failed to test FFmpeg',
      error: error.message,
      success: false
    });
  }
});

// RTMP webhook endpoints for nginx-rtmp module integration
app.post('/api/rtmp/publish', async (req, res) => {
  try {
    console.log('RTMP Publish started:', req.body);
    res.status(200).send('OK');
  } catch (error) {
    console.error('RTMP publish webhook error:', error);
    res.status(500).json({ error: 'Failed to handle RTMP publish' });
  }
});

app.post('/api/rtmp/play', async (req, res) => {
  try {
    console.log('RTMP Play started:', req.body);
    res.status(200).send('OK');
  } catch (error) {
    console.error('RTMP play webhook error:', error);
    res.status(500).json({ error: 'Failed to handle RTMP play' });
  }
});

app.post('/api/rtmp/publish_done', async (req, res) => {
  try {
    console.log('RTMP Publish ended:', req.body);
    res.status(200).send('OK');
  } catch (error) {
    console.error('RTMP publish_done webhook error:', error);
    res.status(500).json({ error: 'Failed to handle RTMP publish done' });
  }
});

app.post('/api/rtmp/play_done', async (req, res) => {
  try {
    console.log('RTMP Play ended:', req.body);
    res.status(200).send('OK');
  } catch (error) {
    console.error('RTMP play_done webhook error:', error);
    res.status(500).json({ error: 'Failed to handle RTMP play done' });
  }
});

app.post('/api/rtmp/record_done', async (req, res) => {
  try {
    console.log('RTMP Recording finished:', req.body);
    res.status(200).send('OK');
  } catch (error) {
    console.error('RTMP record_done webhook error:', error);
    res.status(500).json({ error: 'Failed to handle RTMP record done' });
  }
});

app.post('/api/videos/reorder', async (req, res) => {
  try {
    const { videoIds, updates } = req.body;
    
    // Handle both formats: videoIds array or updates array
    if (videoIds && Array.isArray(videoIds)) {
      // Handle videoIds format (array of IDs in new order)
      const promises = videoIds.map((id, index) => 
        db.query('UPDATE videos SET "playlistOrder" = $1 WHERE id = $2', [index + 1, id])
      );
      
      await Promise.all(promises);
      res.json({ message: 'Playlist reordered successfully' });
    } else if (updates && Array.isArray(updates)) {
      // Handle updates format (array of {id, playlistOrder} objects)
      const promises = updates.map(update => 
        db.query('UPDATE videos SET "playlistOrder" = $1 WHERE id = $2', [update.playlistOrder, update.id])
      );
      
      await Promise.all(promises);
      res.json({ message: 'Playlist reordered successfully' });
    } else {
      return res.status(400).json({ message: 'Either videoIds or updates array is required' });
    }
  } catch (error) {
    console.error('Error reordering playlist:', error);
    res.status(500).json({ error: 'Failed to reorder playlist' });
  }
});

app.post('/api/system-config', async (req, res) => {
  try {
    const { rtmpPort, webPort, dbHost, dbPort, dbName, dbUser, dbPassword, useExternalDb } = req.body;
    
    // Update existing config or create new one
    const result = await db.query(`
      INSERT INTO "systemConfigs" ("rtmpPort", "webPort", "dbHost", "dbPort", "dbName", "dbUser", "dbPassword", "useExternalDb", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (id) DO UPDATE SET
        "rtmpPort" = EXCLUDED."rtmpPort",
        "webPort" = EXCLUDED."webPort",
        "dbHost" = EXCLUDED."dbHost",
        "dbPort" = EXCLUDED."dbPort",
        "dbName" = EXCLUDED."dbName",
        "dbUser" = EXCLUDED."dbUser",
        "dbPassword" = EXCLUDED."dbPassword",
        "useExternalDb" = EXCLUDED."useExternalDb",
        "updatedAt" = NOW()
      RETURNING *
    `, [rtmpPort, webPort, dbHost, dbPort, dbName, dbUser, dbPassword, useExternalDb]);
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating system config:', error);
    res.status(500).json({ error: 'Failed to update system config' });
  }
});

// Database management endpoints
app.post('/api/database/install', async (req, res) => {
  try {
    // Reinitialize database schema
    await initializeDatabase();
    
    // Initialize default stream status and system config
    const statusCount = await db.query('SELECT COUNT(*) FROM "streamStatus"');
    if (parseInt(statusCount.rows[0].count) === 0) {
      await db.query('INSERT INTO "streamStatus" (status, "viewerCount", uptime, "loopPlaylist") VALUES ($1, $2, $3, $4)', ['offline', 0, '00:00:00', false]);
    }

    const configCount = await db.query('SELECT COUNT(*) FROM "systemConfigs"');
    if (parseInt(configCount.rows[0].count) === 0) {
      await db.query('INSERT INTO "systemConfigs" ("rtmpPort", "webPort") VALUES ($1, $2)', [1935, 5000]);
    }

    res.json({ message: 'Default database schema installed successfully' });
  } catch (error) {
    console.error('Error installing database:', error);
    res.status(500).json({ error: 'Failed to install database schema' });
  }
});

app.post('/api/database/backup', async (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup-${timestamp}.sql`;
    const backupDir = path.join(__dirname, 'backups');
    
    // Create backups directory if it doesn't exist
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    
    const backupPath = path.join(backupDir, filename);
    
    // Simple backup by exporting data as INSERT statements
    const tables = ['videos', 'streamConfigs', 'streamStatus', 'systemConfigs'];
    let backupSQL = '-- Sa Plays Roblox Streamer Database Backup\n';
    backupSQL += `-- Generated on ${new Date().toISOString()}\n\n`;
    
    for (const table of tables) {
      try {
        const result = await db.query(`SELECT * FROM "${table}"`);
        if (result.rows.length > 0) {
          backupSQL += `-- Table: ${table}\n`;
          for (const row of result.rows) {
            const columns = Object.keys(row).map(k => `"${k}"`).join(', ');
            const values = Object.values(row).map(v => {
              if (v === null) return 'NULL';
              if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
              if (v instanceof Date) return `'${v.toISOString()}'`;
              return `'${String(v)}'`;
            }).join(', ');
            backupSQL += `INSERT INTO "${table}" (${columns}) VALUES (${values});\n`;
          }
          backupSQL += '\n';
        }
      } catch (tableError) {
        console.warn(`Skipping table ${table}:`, tableError.message);
        backupSQL += `-- Error backing up table ${table}: ${tableError.message}\n`;
      }
    }
    
    // Write backup to file
    fs.writeFileSync(backupPath, backupSQL);
    const stats = fs.statSync(backupPath);
    
    res.json({ 
      message: 'Database backup created successfully',
      filename,
      size: stats.size,
      path: backupPath,
      success: true
    });
  } catch (error) {
    console.error('Error creating backup:', error);
    res.status(500).json({ 
      message: 'Failed to create database backup',
      error: error.message
    });
  }
});

app.get('/api/database/backups', async (req, res) => {
  try {
    const backupDir = path.join(__dirname, 'backups');
    
    if (!fs.existsSync(backupDir)) {
      return res.json({ backups: [] });
    }
    
    const files = fs.readdirSync(backupDir)
      .filter(file => file.endsWith('.sql'))
      .map(file => {
        const filePath = path.join(backupDir, file);
        const stats = fs.statSync(filePath);
        return {
          filename: file,
          size: stats.size,
          created: stats.mtime,
          path: filePath
        };
      })
      .sort((a, b) => b.created.getTime() - a.created.getTime()); // Most recent first
    
    res.json({ backups: files });
  } catch (error) {
    console.error('Error listing backups:', error);
    res.status(500).json({ 
      message: 'Failed to list database backups',
      error: error.message
    });
  }
});

app.post('/api/database/restore', upload.single('backupFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No backup file provided' });
    }

    const backupPath = req.file.path;
    
    // Validate file extension
    if (!backupPath.endsWith('.sql')) {
      fs.unlinkSync(backupPath); // Clean up uploaded file
      return res.status(400).json({ message: 'Invalid file type. Only .sql files are allowed' });
    }

    // Read and execute SQL file
    const sqlContent = fs.readFileSync(backupPath, 'utf8');
    
    // Split by semicolons and execute each statement
    const statements = sqlContent.split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt && !stmt.startsWith('--'));
    
    for (const statement of statements) {
      try {
        if (statement.trim()) {
          await db.query(statement.trim());
        }
      } catch (stmtError) {
        console.warn(`Warning: Could not execute statement: ${statement}`, stmtError.message);
      }
    }
    
    // Clean up uploaded file
    fs.unlinkSync(backupPath);
    
    res.json({ 
      message: 'Database restored successfully',
      filename: req.file.originalname,
      success: true
    });
  } catch (error) {
    console.error('Database restore failed:', error);
    
    // Clean up uploaded file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ 
      message: 'Failed to restore database',
      error: error.message
    });
  }
});

app.delete('/api/database/backups/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const backupPath = path.join(__dirname, 'backups', filename);
    
    if (!fs.existsSync(backupPath) || !filename.endsWith('.sql')) {
      return res.status(404).json({ message: 'Backup file not found' });
    }
    
    fs.unlinkSync(backupPath);
    
    res.json({ 
      message: 'Backup deleted successfully',
      filename: filename,
      success: true
    });
  } catch (error) {
    console.error('Failed to delete backup:', error);
    res.status(500).json({ 
      message: 'Failed to delete backup',
      error: error.message
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  const status = error.status || error.statusCode || 500;
  const message = error.message || 'Internal Server Error';
  res.status(status).json({ error: message });
});

// Catch-all for SPA (must be last)
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Application not built. Run npm run build:client first.');
  }
});

// Complete RTMP Stream Manager with FFmpeg integration
class RTMPStreamManager {
  constructor() {
    this.activeStreams = new Map();
    this.streamConfigs = new Map();
    this.loopEnabled = false;
    this.uptimeInterval = null;
    this.streamStartTime = null;
    this.currentVideoIndex = 0;
    this.playlist = [];
  }

  async startStream(videoId, config) {
    try {
      console.log(`Starting RTMP stream for video ${videoId} with config:`, JSON.stringify(config));
      
      // Get video info
      const videoResult = await db.query('SELECT * FROM videos WHERE id = $1', [videoId]);
      if (videoResult.rows.length === 0) {
        throw new Error('Video not found');
      }
      
      const video = videoResult.rows[0];
      const videoPath = path.join(__dirname, 'uploads', video.filename);
      
      // Check if video file exists
      if (!fs.existsSync(videoPath)) {
        throw new Error('Video file not found on disk');
      }

      // Stop existing stream if running
      const streamKey = `video_${videoId}`;
      if (this.activeStreams.has(streamKey)) {
        this.stopStream(streamKey);
      }

      // Get platform-specific RTMP URL
      const rtmpUrl = this.getPlatformRTMPUrl(config.platform, config.rtmpUrl);
      const fullRtmpUrl = `${rtmpUrl}/${config.streamKey}`;

      // Build FFmpeg command for streaming
      const ffmpegArgs = this.buildFFmpegArgs(videoPath, fullRtmpUrl, config);
      
      console.log(`FFmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);

      // Try to load child_process
      let spawn;
      try {
        const { spawn: spawnFunc } = require('child_process');
        spawn = spawnFunc;
      } catch (error) {
        console.log('child_process not available, using mock stream');
        // Mock streaming for environments without child_process
        this.activeStreams.set(streamKey, { mock: true });
        this.streamStartTime = new Date();
        this.startUptimeTracking();
        return true;
      }

      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
      
      // Handle process events
      ffmpegProcess.stdout?.on('data', (data) => {
        console.log(`FFmpeg stdout: ${data}`);
      });
      
      ffmpegProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        console.log(`FFmpeg stderr: ${output}`);
        
        // Check for streaming success indicators
        if (output.includes('Stream mapping:') || output.includes('Press [q] to stop')) {
          console.log('FFmpeg stream successfully connected to RTMP server');
        }
      });
      
      ffmpegProcess.on('close', (code) => {
        console.log(`FFmpeg process exited with code ${code}`);
        this.activeStreams.delete(streamKey);
        
        // If loop is enabled, play next video
        if (this.loopEnabled) {
          this.playNextVideo();
        } else {
          this.stopUptimeTracking();
          this.updateStreamStatus('offline', null);
        }
      });
      
      ffmpegProcess.on('error', (error) => {
        console.error(`FFmpeg error: ${error.message}`);
        this.activeStreams.delete(streamKey);
        this.stopUptimeTracking();
        this.updateStreamStatus('error', null);
      });
      
      // Store the process and config
      this.activeStreams.set(streamKey, ffmpegProcess);
      this.streamConfigs.set(streamKey, config);
      this.streamStartTime = new Date();
      this.startUptimeTracking();
      
      // Load playlist for loop functionality
      await this.loadPlaylist();
      
      return true;
    } catch (error) {
      console.error('Error starting RTMP stream:', error);
      return false;
    }
  }

  async stopStream(streamKey = null) {
    try {
      if (streamKey) {
        const process = this.activeStreams.get(streamKey);
        if (process && !process.mock) {
          process.kill('SIGTERM');
        }
        this.activeStreams.delete(streamKey);
      } else {
        // Stop all streams
        for (const [key, process] of this.activeStreams) {
          if (!process.mock) {
            process.kill('SIGTERM');
          }
        }
        this.activeStreams.clear();
      }
      
      this.stopUptimeTracking();
      console.log('RTMP stream stopped');
      return true;
    } catch (error) {
      console.error('Error stopping RTMP stream:', error);
      return false;
    }
  }

  stopAllStreams() {
    return this.stopStream();
  }

  setLoopEnabled(enabled) {
    this.loopEnabled = enabled;
    console.log(`24x7 loop ${enabled ? 'enabled' : 'disabled'}`);
  }

  isLoopEnabled() {
    return this.loopEnabled;
  }

  isStreaming() {
    return this.activeStreams.size > 0;
  }

  async loadPlaylist() {
    try {
      const result = await db.query('SELECT * FROM videos ORDER BY playlist_order ASC');
      this.playlist = result.rows;
      console.log(`Loaded playlist with ${this.playlist.length} videos`);
    } catch (error) {
      console.error('Error loading playlist:', error);
      this.playlist = [];
    }
  }

  async playNextVideo() {
    if (!this.loopEnabled || this.playlist.length === 0) {
      return;
    }

    try {
      // Find current video index
      const currentStatus = await db.query('SELECT * FROM "streamStatus" ORDER BY id DESC LIMIT 1');
      const currentVideoId = currentStatus.rows[0]?.currentVideoId;
      
      if (currentVideoId) {
        this.currentVideoIndex = this.playlist.findIndex(v => v.id === currentVideoId);
      }
      
      // Move to next video
      this.currentVideoIndex = (this.currentVideoIndex + 1) % this.playlist.length;
      const nextVideo = this.playlist[this.currentVideoIndex];
      
      if (nextVideo) {
        console.log(`Playing next video: ${nextVideo.title}`);
        
        // Update current video in database
        await db.query('UPDATE "streamStatus" SET "currentVideoId" = $1', [nextVideo.id]);
        
        // Get current stream config
        const configResult = await db.query('SELECT * FROM "streamConfigs" WHERE "isActive" = true ORDER BY id DESC LIMIT 1');
        const streamConfig = configResult.rows[0];
        
        if (streamConfig) {
          // Start streaming the next video
          await this.startStream(nextVideo.id, {
            platform: streamConfig.platform,
            streamKey: streamConfig.streamKey,
            rtmpUrl: streamConfig.rtmpUrl,
            resolution: streamConfig.resolution,
            framerate: streamConfig.framerate,
            bitrate: streamConfig.bitrate,
          });
        }
      }
    } catch (error) {
      console.error('Error playing next video:', error);
    }
  }

  getPlatformRTMPUrl(platform, customUrl) {
    switch (platform?.toLowerCase()) {
      case 'youtube':
        return 'rtmp://a.rtmp.youtube.com/live2';
      case 'twitch':
        return 'rtmp://live.twitch.tv/app';
      case 'facebook':
        return 'rtmps://live-api-s.facebook.com:443/rtmp';
      case 'custom':
        return customUrl || 'rtmp://localhost:1935/live';
      default:
        return customUrl || 'rtmp://a.rtmp.youtube.com/live2';
    }
  }

  buildFFmpegArgs(inputPath, outputUrl, config) {
    const args = [
      '-re', // Read input at native frame rate
      '-i', inputPath, // Input file
      '-c:v', 'libx264', // Video codec
      '-preset', 'ultrafast', // Encoding preset for speed
      '-tune', 'zerolatency', // Low latency tuning
      '-b:v', `${config.bitrate || 2500}k`, // Video bitrate
      '-maxrate', `${config.bitrate || 2500}k`, // Max bitrate
      '-bufsize', `${(config.bitrate || 2500) * 2}k`, // Buffer size
      '-r', String(config.framerate || 30), // Frame rate
      '-g', String((config.framerate || 30) * 2), // GOP size
      '-c:a', 'aac', // Audio codec
      '-b:a', '128k', // Audio bitrate
      '-ar', '44100', // Audio sample rate
      '-f', 'flv', // Output format
      outputUrl // Output URL
    ];

    // Add resolution scaling if specified
    if (config.resolution && config.resolution !== 'original') {
      const [width, height] = config.resolution.split('x');
      if (width && height) {
        args.splice(-2, 0, '-vf', `scale=${width}:${height}`);
      }
    }

    return args;
  }

  startUptimeTracking() {
    this.stopUptimeTracking(); // Clear any existing interval
    
    this.uptimeInterval = setInterval(async () => {
      if (this.streamStartTime) {
        const uptime = this.formatUptime(Date.now() - this.streamStartTime.getTime());
        try {
          await db.query('UPDATE "streamStatus" SET uptime = $1 WHERE id = (SELECT MAX(id) FROM "streamStatus")', [uptime]);
        } catch (error) {
          console.error('Error updating uptime:', error);
        }
      }
    }, 1000);
  }

  stopUptimeTracking() {
    if (this.uptimeInterval) {
      clearInterval(this.uptimeInterval);
      this.uptimeInterval = null;
    }
    this.streamStartTime = null;
  }

  formatUptime(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  async updateStreamStatus(status, videoId) {
    try {
      await db.query(
        'UPDATE "streamStatus" SET status = $1, "currentVideoId" = $2, "startedAt" = $3 WHERE id = (SELECT MAX(id) FROM "streamStatus")',
        [status, videoId, status === 'live' ? new Date() : null]
      );
    } catch (error) {
      console.error('Error updating stream status:', error);
    }
  }
}

const rtmpManager = new RTMPStreamManager();

// Initialize database tables
async function initializeDatabase() {
  if (!db) return;
  
  try {
    // Create tables if they don't exist (basic versions)
    await db.query(`
      CREATE TABLE IF NOT EXISTS videos (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        filename TEXT NOT NULL,
        "fileSize" INTEGER NOT NULL,
        duration TEXT NOT NULL,
        "thumbnailUrl" TEXT,
        "playlistOrder" INTEGER NOT NULL,
        "uploadedAt" TIMESTAMP DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS "streamConfigs" (
        id SERIAL PRIMARY KEY,
        platform TEXT NOT NULL,
        "streamKey" TEXT NOT NULL,
        "rtmpUrl" TEXT,
        resolution TEXT NOT NULL,
        framerate INTEGER NOT NULL,
        bitrate INTEGER NOT NULL,
        "audioQuality" INTEGER NOT NULL,
        "isActive" BOOLEAN DEFAULT false
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS "streamStatus" (
        id SERIAL PRIMARY KEY,
        status TEXT NOT NULL,
        "viewerCount" INTEGER DEFAULT 0,
        uptime TEXT DEFAULT '00:00:00',
        "currentVideoId" INTEGER,
        "startedAt" TIMESTAMP,
        "loopPlaylist" BOOLEAN DEFAULT false
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS "systemConfigs" (
        id SERIAL PRIMARY KEY,
        "rtmpPort" INTEGER DEFAULT 1935,
        "webPort" INTEGER DEFAULT 5000,
        "dbHost" TEXT DEFAULT 'localhost',
        "dbPort" INTEGER DEFAULT 5432,
        "dbName" TEXT DEFAULT 'streaming_db',
        "dbUser" TEXT DEFAULT '',
        "dbPassword" TEXT DEFAULT '',
        "useExternalDb" BOOLEAN DEFAULT false,
        "updatedAt" TIMESTAMP DEFAULT NOW()
      )
    `);

    console.log('Database tables initialized');
    
    // Initialize default data if tables are empty
    const statusCount = await db.query('SELECT COUNT(*) FROM "streamStatus"');
    if (parseInt(statusCount.rows[0].count) === 0) {
      await db.query('INSERT INTO "streamStatus" (status, "viewerCount", uptime, "loopPlaylist") VALUES ($1, $2, $3, $4)', ['offline', 0, '00:00:00', false]);
      console.log('Default stream status initialized');
    }

    const configCount = await db.query('SELECT COUNT(*) FROM "systemConfigs"');
    if (parseInt(configCount.rows[0].count) === 0) {
      await db.query('INSERT INTO "systemConfigs" ("rtmpPort", "webPort") VALUES ($1, $2)', [1935, 5000]);
      console.log('Default system configuration initialized');
    }
    
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Start server with async initialization
async function startServer() {
  initializeDependencies();
  
  server.listen(port, '0.0.0.0', async () => {
    console.log(`Sa Plays Roblox Streamer (Standalone) running on port ${port}`);
    
    // Initialize database on startup
    await initializeDatabase();
    
    console.log('Server startup complete - ready for streaming!');
  });
}

// Start the server
startServer().catch(console.error);