import process from 'node:process';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
createApp().listen(port, () => process.stdout.write(`orders-api listening on ${port}\n`));
