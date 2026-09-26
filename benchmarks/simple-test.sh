#!/bin/bash

# Port base of the stack to test: 3010 (Node 22), 3020 (24), 3030 (26)
BASE=${PORT_BASE:-3010}

echo "Testing Mock Service..."
curl -s http://localhost:$((BASE + 1))/api/data | jq .

echo -e "\n\nTesting Express + @nestjs/axios..."
time curl -s http://localhost:$((BASE + 2))/api | jq '.duration'

echo -e "\n\nTesting Express + nestjs-axios-undici..."
time curl -s http://localhost:$((BASE + 3))/api | jq '.duration'

echo -e "\n\nTesting Fastify + @nestjs/axios..."
time curl -s http://localhost:$((BASE + 4))/api | jq '.duration'

echo -e "\n\nTesting Fastify + nestjs-axios-undici..."
time curl -s http://localhost:$((BASE + 5))/api | jq '.duration'

echo -e "\n\nRunning 10 concurrent requests to Express + @nestjs/axios..."
time seq 1 10 | xargs -P 10 -I {} curl -s http://localhost:$((BASE + 2))/api -o /dev/null

echo -e "\n\nRunning 10 concurrent requests to Express + nestjs-axios-undici..."
time seq 1 10 | xargs -P 10 -I {} curl -s http://localhost:$((BASE + 3))/api -o /dev/null
