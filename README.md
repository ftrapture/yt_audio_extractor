# yt-cipher

An http api wrapper for yt-dlp/ejs.

## Getting Started

### Lavalink

The absolute easiest way to use this with Lavalink is to just add this to the youtube plugin config:

```yaml
plugins:
  youtube:
    remoteCipher:
      url: "http://localhost:3030/"
      userAgent: "your_service_name" # Optional
```

## Public instance

You can use the public instance without a password at `https://cipher.kikkia.dev/`. I do my best to keep it up and running and decently fast, but I don't guarantee 100% uptime. Feel free to host it yourself or use the public API.

> [!WARNING]
> Ratelimit of 10 requests/sec (should be fine up to 1000+ active players). If you have more than 1k players you probably want to host it yourself.

## Hosting yourself

To run the API server locally or on a VPS:

### Prerequisites

- Node.js (v18+)
- ffmpeg installed and added to your system PATH

### Installation & Run

1. Clone the repository:
   ```bash
   git clone https://github.com/kikkia/yt-cipher.git
   cd yt-cipher
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the server:
   ```bash
   npm run api
   ```

The server will start on port `3030` by default.

### API Endpoints

- **Resolve muxed stream URL:**
  ```http
  GET /resolve?video=<videoId>&mode=muxed
  ```
- **Stream/Demux audio:**
  ```http
  GET /audio?video=<videoId>&format=mp3
  ```
- **Health check:**
  ```http
  GET /health
  ```
