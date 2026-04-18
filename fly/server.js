import http from 'http';

const ALLOWED_ORIGIN = 'https://chquordata.github.io';
const SPORT_IDS = { mma: 7, tennis: 33 };
const PORT = process.env.PORT || 8080;

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health') {
    return send(res, 200, { status: 'ok', version: '1.0' });
  }

  const m = url.pathname.match(/^\/pinnacle\/(mma|tennis)$/);
  if (!m) return send(res, 404, { error: 'Not found' });

  try {
    const data = await getPinnacleOdds(process.env.PINNACLE_USER, process.env.PINNACLE_PWD, SPORT_IDS[m[1]]);
    send(res, 200, data);
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function getPinnacleOdds(user, pwd, sportId) {
  const auth = Buffer.from(`${user}:${pwd}`).toString('base64');
  const headers = { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' };

  const [fixturesRes, oddsRes] = await Promise.all([
    fetch(`https://api.pinnacle.com/v1/fixtures?sportId=${sportId}`, { headers }),
    fetch(`https://api.pinnacle.com/v2/odds?sportId=${sportId}&oddsFormat=American`, { headers }),
  ]);

  if (!fixturesRes.ok) throw new Error(`Pinnacle fixtures ${fixturesRes.status}: ${(await fixturesRes.text()).slice(0, 200)}`);
  if (!oddsRes.ok) throw new Error(`Pinnacle odds ${oddsRes.status}: ${(await oddsRes.text()).slice(0, 200)}`);

  const [fixtures, odds] = await Promise.all([fixturesRes.json(), oddsRes.json()]);

  const eventMap = new Map();
  fixtures.league?.forEach(lg => lg.events?.forEach(ev => {
    if (ev.status === 'O') eventMap.set(ev.id, { home: ev.home, away: ev.away, starts: ev.starts });
  }));

  const result = [];
  odds.leagues?.forEach(lg => lg.events?.forEach(ev => {
    const fix = eventMap.get(ev.id);
    if (!fix) return;
    const ml = ev.periods?.find(p => p.number === 0)?.moneyline;
    if (!ml?.home || !ml?.away) return;
    result.push({
      id: `pinnacle_${ev.id}`,
      home_team: fix.home,
      away_team: fix.away,
      commence_time: fix.starts,
      bookmakers: [{ key: 'pinnacle', title: 'Pinnacle', markets: [{ key: 'h2h', outcomes: [
        { name: fix.home, price: ml.home },
        { name: fix.away, price: ml.away },
      ]}]}]
    });
  }));

  return result;
}

server.listen(PORT, () => console.log(`Listening on port ${PORT}`));
