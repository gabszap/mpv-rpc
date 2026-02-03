# GuessIt API for Vercel

A serverless API wrapper for the [guessit](https://pypi.org/project/guessit/) Python library, deployed on Vercel.

## What it does

Parses video filenames and extracts metadata like title, season, episode, quality, etc.

## API Endpoint

**POST** `/api/parse`

### Request Body

```json
{
  "filename": "[Judas] Jujutsu Kaisen - S01E01 [1080p].mkv"
}
```

### Response

```json
{
  "title": "Jujutsu Kaisen",
  "season": 1,
  "episode": 1,
  "screen_size": "1080p",
  "release_group": "Judas",
  "container": "mkv",
  "type": "episode"
}
```

## Deployment

1. Install Vercel CLI:
   ```bash
   npm i -g vercel
   ```

2. Deploy:
   ```bash
   cd guessit-api
   vercel
   ```

3. Set your API URL in mpv-rpc's `.env`:
   ```env
   GUESSIT_API_URL=https://your-project.vercel.app/api/parse
   ```

## Local Development

```bash
cd guessit-api
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
vercel dev
```

## License

MIT
