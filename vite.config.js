import { defineConfig } from 'vite';
import fs from 'node:fs';

// Dev-only helper: POST a PNG data URL to /__snap?name=x to save it in .snaps/ (used for visual QA).
const snap = {
  name: 'snap',
  configureServer(server) {
    server.middlewares.use('/__snap', (req, res) => {
      const name = new URL(req.url, 'http://x').searchParams.get('name') || 'snap';
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        fs.mkdirSync('.snaps', { recursive: true });
        fs.writeFileSync(`.snaps/${name}.png`, Buffer.from(body.split(',')[1], 'base64'));
        res.end('ok');
      });
    });
  },
};

export default defineConfig({ plugins: [snap], server: { port: 5178 } });
