const mongoose = require('mongoose');
const crypto = require('crypto');
const { DateTime } = require('luxon');

// Models
const VisitEvent = require('./models/VisitEvent');
const VisitCreditLedger = require('./models/VisitCreditLedger');
const ProductDailyTraffic = require('./models/ProductDailyTraffic');
const FounderDailyTraffic = require('./models/FounderDailyTraffic');
const ProductStats = require('./models/ProductStats');

// Minimal Schemas if strictly needed, but typically shared models are best.
// Assuming we have the models from the copy operation.

// User and Product access:
// In a merged world, we should probably use the real User/Product models if available in the models folder.
// But the previous worker defined them inline or assumed raw access. 
// We'll stick to the inline definition or if the copied models directory has them, use them.
// The copied 'models' directory came from eventworker, which... wait.
// eventworker/worker.js defined UserSchema inline:
// const UserSchema = new mongoose.Schema({ credits: Number });
// const User = mongoose.model('User', UserSchema);

// If the copied 'models' folder DOES NOT contain User.js, we must define it here.
// I'll check the copied models in a second. For now, preserving inline definitions to ensure safety.

const UserSchema = new mongoose.Schema({ credits_balance: Number });
// Check if model already exists to avoid OverwriteModelError
const User = mongoose.models.User || mongoose.model('User', UserSchema);

const ProductSchema = new mongoose.Schema({ founder_id: mongoose.Schema.Types.ObjectId });
const Product = mongoose.models.Product || mongoose.model('Product', ProductSchema);

const processEvent = async (eventPayload) => {
    // eventPayload is already an object, no need to JSON.parse if passed from in-memory
    const { visit_id, ip, country, city, browser, os, device_type, timestamp } = eventPayload;

    console.log(`[EventWorker] Processing visit_id: ${visit_id}`);

    try {
        // 1. Find Initial Visit
        const visitRecord = await VisitEvent.findOne({ visit_id });

        if (!visitRecord) {
            console.warn(`Visit ID ${visit_id} not found (orphaned beacon?)`);
            return;
        }

        if (visitRecord.status === 'CONFIRMED' || visitRecord.status === 'BILLED') {
            return;
        }

        // 2. Update Visit Record
        visitRecord.status = 'CONFIRMED';
        visitRecord.ip_hash = crypto.createHash('sha256').update(ip).digest('hex');
        visitRecord.country = country;
        visitRecord.city = city;
        visitRecord.browser = browser;
        visitRecord.os = os;
        visitRecord.device_type = device_type;
        visitRecord.confirmed_at = new Date(timestamp);
        await visitRecord.save();

        // 3. Credit Deduction Logic
        const today = DateTime.now().toISODate();
        const { product_id, founder_id, session_id } = visitRecord;

        const existingCharge = await VisitCreditLedger.findOne({
            product_id,
            session_id,
            date: today
        });

        let billable = false;

        if (!existingCharge) {
            const founder = await User.findById(founder_id);
            if (founder && founder.credits_balance > 0) {
                billable = true;

                // Transaction: Deduct Credit
                await User.findByIdAndUpdate(founder_id, { $inc: { credits_balance: -1 } });

                // Create Ledger Entry
                await VisitCreditLedger.create({
                    product_id,
                    founder_id,
                    session_id,
                    date: today,
                    visit_id,
                    credits_deducted: 1
                });

                visitRecord.status = 'BILLED';
                await visitRecord.save();
            }
        }

        // 4. Update Aggregates
        const incUpdate = { $inc: { visits: 1 } };
        if (billable) incUpdate.$inc.credits_consumed = 1;
        if (!existingCharge) incUpdate.$inc.unique_visits = 1;

        await ProductDailyTraffic.findOneAndUpdate(
            { product_id, date: today },
            incUpdate,
            { upsert: true, new: true }
        );

        await FounderDailyTraffic.findOneAndUpdate(
            { founder_id, date: today },
            { $inc: { visits: 1, credits_consumed: billable ? 1 : 0 } },
            { upsert: true }
        );

        // 5. Update Aggregate ProductStats (Admin View)
        await ProductStats.findOneAndUpdate(
            { product_id },
            {
                $inc: { clicks_total: 1, clicks_24h: 1 },
                $set: { last_clicked_at: new Date(timestamp), updated_at: new Date() }
            },
            { upsert: true }
        );

        if (billable) {
            console.log(`[EventWorker] BILLED visit_id: ${visit_id}`);
        } else {
            console.log(`[EventWorker] SKIPPED billing: ${existingCharge ? 'Duplicate' : 'No Credits'}`);
        }

    } catch (err) {
        console.error(`[EventWorker] Error processing ${visit_id}:`, err.message);
    }
};

module.exports = { processEvent };
