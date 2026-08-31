import fs from " node:fs\; const b64 = process.argv[2]; fs.appendFileSync(\tests/stress/tier5-adversarial-challenge.test.ts\, Buffer.from(b64, \base64\).toString(\utf8\));
