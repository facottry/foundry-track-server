require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const uaparser = require('ua-parser-js');
const geoip = require('geoip-lite');
const { processEvent } = require('./worker');

const app = express();
const PORT = process.env.PORT || 5002;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/foundry';

// In-Memory Queue
const eventQueue = [];
let isProcessing = false;

const triggerQueue = async () => {
    if (isProcessing) return;
    isProcessing = true;

    while (eventQueue.length > 0) {
        const payload = eventQueue.shift();
        try {
            await processEvent(payload);
        } catch (err) {
            console.error('[TrackServer] Queue Queue Processing Error:', err);
        }
    }
    isProcessing = false;
};

// Database Connection
mongoose.connect(MONGO_URI)
    .then(() => console.log('[TrackServer] Connected to MongoDB'))
    .catch(err => console.error('[TrackServer] MongoDB Connection Error:', err));

app.use(cors({ origin: '*' }));
app.use(express.json());

/**
 * Purpose: High-speed ingestion for traffic confirmation beacons.
 * Inputs: visit_id (Body).
 * Outputs: 200 OK (Queued).
 * Side Effects: Pushes raw event to in-memory queue.
 */
app.post('/track/visit-confirm', async (req, res) => {
    const { visit_id } = req.body;

    // Structured Log: Ingestion Attempt
    console.log(`[TrackServer] Ingesting visit: ${visit_id}`);

    if (!visit_id) {
        console.warn(`[TrackServer] Missing visit_id`);
        return res.status(400).json({ error: 'Missing visit_id' });
    }

    try {
        // Enrichment
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
        const ua = req.headers['user-agent'] || '';

        const geo = geoip.lookup(ip);
        const uaResult = uaparser(ua);

        const eventPayload = {
            visit_id,
            ip,
            country: geo?.country || 'Unknown',
            city: geo?.city || 'Unknown',
            browser: uaResult.browser.name || 'Unknown',
            os: uaResult.os.name || 'Unknown',
            device_type: uaResult.device.type || 'desktop',
            timestamp: Date.now()
        };

        // Push to In-Memory Queue
        eventQueue.push(eventPayload);
        triggerQueue(); // Fire and forget logic

        // Respond fast
        res.status(200).json({ status: 'queued' });

    } catch (err) {
        console.error('Track error:', err);
        res.status(500).json({ error: 'Internal error' });
    }
});

app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, () => {
    console.log(`TrackServer running on port ${PORT}`);
});
