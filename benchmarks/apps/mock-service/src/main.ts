import fastify from 'fastify';

// logger: false - per-request logging on the mock backend caps its own
// throughput and would show up as noise in every configuration's numbers.
const app = fastify({ logger: false });

const mockData = {
  id: Math.floor(Math.random() * 10000),
  name: 'Mock Service Response',
  timestamp: new Date().toISOString(),
  data: {
    status: 'success',
    message: 'Response from mock service',
    value: Math.random()
  }
};

app.get('/api/data', async (request, reply) => {
  return mockData;
});

const port = process.env.PORT || 3001;
const host = process.env.HOST || '0.0.0.0';

app.listen({ port: Number(port), host }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Mock service listening on ${address}`);
});