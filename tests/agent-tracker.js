"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanupAllAgents = cleanupAllAgents;
const http = require("http");
const https = require("https");
// Track all agents created during tests
const agents = new Set();
// Override the Agent constructors to track instances
const originalHttpAgent = http.Agent;
const originalHttpsAgent = https.Agent;
class TrackedHttpAgent extends originalHttpAgent {
    constructor(options) {
        super(options);
        agents.add(this);
    }
}
class TrackedHttpsAgent extends originalHttpsAgent {
    constructor(options) {
        super(options);
        agents.add(this);
    }
}
// Replace the global constructors
http.Agent = TrackedHttpAgent;
https.Agent = TrackedHttpsAgent;
// Cleanup function to destroy all agents
function cleanupAllAgents() {
    agents.forEach(agent => {
        try {
            agent.destroy();
        }
        catch (error) {
            // Ignore errors during cleanup
        }
    });
    agents.clear();
}
// Setup global cleanup
if (typeof afterAll !== 'undefined') {
    afterAll(() => {
        cleanupAllAgents();
    });
}
