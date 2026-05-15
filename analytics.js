/**
 * Vercel Web Analytics Configuration
 * 
 * This file initializes Vercel Web Analytics for the application.
 * 
 * For vanilla JavaScript projects deployed on Vercel, this script sets up
 * the analytics queue and prepares for the Vercel-injected analytics script.
 * When deployed on Vercel with Web Analytics enabled in the dashboard,
 * the analytics script is automatically injected at /_vercel/insights/script.js
 * 
 * Docs: https://vercel.com/docs/analytics/quickstart
 */

// Initialize Vercel Analytics queue
// This must be set up before the Vercel analytics script loads
window.va = window.va || function () {
  (window.vaq = window.vaq || []).push(arguments);
};

// Optional: Configure analytics behavior
// Uncomment and customize as needed:

// Filter events before sending
// window.va('beforeSend', (event) => {
//   // Example: Don't track private pages
//   if (event.url.includes('/private')) {
//     return null;
//   }
//   return event;
// });

// Track custom events
// window.va('event', { name: 'custom_event', data: { key: 'value' } });

console.log('[Analytics] Vercel Web Analytics initialized');
