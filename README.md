# EDGE TERMINAL

Bloomberg Terminal-style sports betting edge scanner. Compares odds across major US sportsbooks in real time and flags mispriced lines.

## How It Works

1. Pulls odds from 10+ US sportsbooks via [The Odds API](https://the-odds-api.com)
2. Calculates consensus implied probability for every side of every market
3. Flags any book offering odds that deviate >3% from consensus as an "edge"
4. Ranks edges by magnitude and displays book-by-book breakdowns

## Setup

### 1. Get an API Key (Free)

Go to [the-odds-api.com](https://the-odds-api.com/#get-access) and sign up for a free key. Free tier = 500 requests/month.

### 2. Deploy to GitHub Pages

```bash
# Create a new repo (or use an existing one)
gh repo create edge-terminal --public --clone
cd edge-terminal

# Copy the file
cp /path/to/index.html .

# Push
git add index.html
git commit -m "Initial deploy"
git push origin main
```

Then in your repo Settings > Pages, set Source to **main branch** / **root**.

Your dashboard will be live at `https://<username>.github.io/edge-terminal/`

### 3. Enter Your API Key

Open the dashboard and paste your Odds API key when prompted. It's stored in your browser's localStorage — never transmitted anywhere except the-odds-api.com.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `R` | Refresh / rescan |
| `↑` `↓` | Navigate edges |
| `Enter` | Select edge |
| `1`-`7` | Switch sport (ALL/NFL/NBA/MLB/NHL/TENNIS/MMA) |
| `K` | Open API key setup |
| `?` | Toggle shortcuts |
| `Esc` | Close overlay |

## Sports Covered

NFL, NBA, MLB, NHL, Tennis (all active ATP/WTA tournaments), UFC/MMA

## Edge Tiers

- **HIGH** (green): 8%+ deviation from consensus — strongest signal
- **MEDIUM** (amber): 5-8% deviation — solid edge
- **LOW**: 3-5% deviation — marginal, watch for movement

## API Usage

Each sport refresh = 1 API call per active sport. A full scan across all sports typically uses 5-8 calls. At 500/month free tier, that's ~2 full scans per day.

## Tech

Zero dependencies. Single HTML file. Vanilla JS. No build step. Works on any static host.
