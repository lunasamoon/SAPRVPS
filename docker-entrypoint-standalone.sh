#!/bin/sh
set -e

echo "Starting Sa Plays Roblox Streamer (Standalone Docker Version)..."

# Wait for database
if [ -n "$DATABASE_URL" ]; then
    echo "Waiting for database..."
    
    # Extract host and port from DATABASE_URL
    DB_HOST=$(echo $DATABASE_URL | sed -n 's/.*@\([^:]*\):.*/\1/p')
    DB_PORT=$(echo $DATABASE_URL | sed -n 's/.*:\([0-9]*\)\/.*/\1/p')
    
    # Default to postgres defaults if extraction fails
    DB_HOST=${DB_HOST:-postgres}
    DB_PORT=${DB_PORT:-5432}
    
    # Wait for database to be ready
    for i in $(seq 1 30); do
        if nc -z "$DB_HOST" "$DB_PORT" 2>/dev/null; then
            echo "Database is ready!"
            break
        fi
        echo "Waiting for database... ($i/30)"
        sleep 2
    done
    
    if ! nc -z "$DB_HOST" "$DB_PORT" 2>/dev/null; then
        echo "Database connection timeout!"
        exit 1
    fi
else
    echo "No DATABASE_URL provided, skipping database check"
fi

# Create required directories
mkdir -p /app/uploads /app/backups /tmp/hls

# Set permissions
chown -R streaming:streaming /app/uploads /app/backups 2>/dev/null || true

# Start nginx in background (if available)
if command -v nginx >/dev/null 2>&1; then
    echo "Starting nginx for RTMP support..."
    
    # Check if RTMP module is available
    if nginx -V 2>&1 | grep -q "rtmp"; then
        echo "RTMP module detected, using full nginx-standalone.conf"
        # Test nginx configuration with RTMP
        if nginx -c /app/nginx-standalone.conf -t 2>/dev/null; then
            nginx -c /app/nginx-standalone.conf -g 'daemon on;'
            echo "Nginx with RTMP started successfully"
        else
            echo "RTMP nginx config failed, trying simple config..."
            # Fall back to simple config
            if nginx -c /app/nginx-standalone-simple.conf -t 2>/dev/null; then
                nginx -c /app/nginx-standalone-simple.conf -g 'daemon on;'
                echo "Nginx started with simple configuration (no RTMP)"
            else
                echo "All nginx configurations failed, skipping nginx startup"
            fi
        fi
    else
        echo "No RTMP module found, using simple nginx configuration"
        # Use simple config without RTMP
        if nginx -c /app/nginx-standalone-simple.conf -t 2>/dev/null; then
            nginx -c /app/nginx-standalone-simple.conf -g 'daemon on;'
            echo "Nginx started with simple configuration (no RTMP)"
        else
            echo "Simple nginx configuration failed, skipping nginx startup"
        fi
    fi
else
    echo "Nginx not available, RTMP streaming will use direct connection"
fi

# Start the application
echo "Starting Sa Plays Roblox Streamer application..."
cd /app

# Set NODE_ENV
export NODE_ENV=production

# Run the standalone server
exec node server-standalone.js