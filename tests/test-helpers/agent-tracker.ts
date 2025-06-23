import * as http from 'http';
import * as https from 'https';

// Track all agents created during tests
const agents = new Set<http.Agent | https.Agent>();

// Store original constructors
const originalHttpAgent = http.Agent;
const originalHttpsAgent = https.Agent;

// Instead of trying to replace the constructors (which may be read-only),
// we'll monkey-patch the destroy method to track cleanup
const originalHttpDestroy = originalHttpAgent.prototype.destroy;
const originalHttpsDestroy = originalHttpsAgent.prototype.destroy;

// Track agent creation by patching constructors if possible
try {
  // Try to patch http.Agent
  const OriginalAgent = http.Agent;
  (http as any).Agent = class extends OriginalAgent {
    constructor(options?: http.AgentOptions) {
      super(options);
      agents.add(this);
    }
  };
} catch (e) {
  // If we can't replace the constructor, patch the prototype
  const originalHttpConstructor = originalHttpAgent.prototype.constructor;
  originalHttpAgent.prototype.constructor = function(this: http.Agent, options?: http.AgentOptions) {
    const instance = originalHttpConstructor.call(this, options);
    agents.add(this);
    return instance;
  };
}

try {
  // Try to patch https.Agent
  const OriginalAgent = https.Agent;
  (https as any).Agent = class extends OriginalAgent {
    constructor(options?: https.AgentOptions) {
      super(options);
      agents.add(this);
    }
  };
} catch (e) {
  // If we can't replace the constructor, patch the prototype
  const originalHttpsConstructor = originalHttpsAgent.prototype.constructor;
  originalHttpsAgent.prototype.constructor = function(this: https.Agent, options?: https.AgentOptions) {
    const instance = originalHttpsConstructor.call(this, options);
    agents.add(this);
    return instance;
  };
}

// Override destroy methods to track cleanup
originalHttpAgent.prototype.destroy = function(this: http.Agent) {
  agents.delete(this);
  return originalHttpDestroy.call(this);
};

originalHttpsAgent.prototype.destroy = function(this: https.Agent) {
  agents.delete(this);
  return originalHttpsDestroy.call(this);
};

// Cleanup function to destroy all agents
export function cleanupAllAgents(): void {
  agents.forEach(agent => {
    try {
      if (agent && typeof agent.destroy === 'function') {
        agent.destroy();
      }
    } catch (error) {
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

// Also cleanup on process exit
if (typeof process !== 'undefined' && process.on) {
  process.on('exit', cleanupAllAgents);
}