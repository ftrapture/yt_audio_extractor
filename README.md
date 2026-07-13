# yt-cipher

An http rest api for extracting audio from youtube videos.

## Getting Started

## Public instance

You can use the public instance `http://40.81.237.84:3030/`. It's selfhosted, so I don't guarantee 100% uptime. Feel free to host it yourself or use the public API.

> [!WARNING]
> Ratelimit of 15 requests/sec, if you're planning more than that, you probably want to host it yourself.

## Hosting yourself

To run the API server locally or on a VPS:

### Prerequisites

- Node.js (v18+)
- ffmpeg installed and added to your system PATH

### Installation & Run

1. Clone the repository:
   ```bash
   git clone https://github.com/ftrapture/yt_audio_extractor.git
   cd yt_audio_extractor
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
