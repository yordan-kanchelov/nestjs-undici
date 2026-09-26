#!/bin/bash

# Script to test performance across Node.js 22, 24, and 26 with health checks

echo "======================================"
echo "NestJS Performance Test - All Node Versions"
echo "======================================"
echo ""

# Create results directory if it doesn't exist
mkdir -p results

# The apps use the library build from .lib/ (see scripts/pack-lib.sh)
if [ ! -f .lib/nestjs-axios-undici.tgz ]; then
    ./scripts/pack-lib.sh
fi

# Recorded in the results so reports say where and against what they were produced
export BENCHMARK_ENVIRONMENT="${BENCHMARK_ENVIRONMENT:-Local run via test-all-node-versions.sh ($(uname -s), $(nproc 2>/dev/null || sysctl -n hw.ncpu) CPUs, Docker Compose)}"
export LIBRARY_REF="${LIBRARY_REF:-nestjs-axios-undici@$(node -p "require('../package.json').version") ($(git rev-parse --short HEAD 2>/dev/null || echo 'working tree'))}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check if a service is healthy
check_service_health() {
    local SERVICE_NAME=$1
    local URL=$2
    local MAX_RETRIES=30
    local RETRY_DELAY=2
    local RETRIES=0
    
    echo -n "Checking $SERVICE_NAME health at $URL..."
    
    while [ $RETRIES -lt $MAX_RETRIES ]; do
        if curl -sf "$URL" > /dev/null 2>&1; then
            echo -e " ${GREEN}✓ Healthy${NC}"
            return 0
        fi
        
        RETRIES=$((RETRIES + 1))
        if [ $RETRIES -lt $MAX_RETRIES ]; then
            echo -n "."
            sleep $RETRY_DELAY
        fi
    done
    
    echo -e " ${RED}✗ Failed${NC}"
    return 1
}

# Node.js versions under test and their host port base (ports base+1 .. base+7)
NODE_VERSIONS=(22 24 26)

port_base_for() {
    case "$1" in
        22) echo 3010 ;;
        24) echo 3020 ;;
        26) echo 3030 ;;
        *) echo "Unknown Node.js version: $1" >&2; return 1 ;;
    esac
}

compose_file_for() {
    echo "docker-compose-node$1.yml"
}

# Function to check all services for a Node version
check_all_services() {
    local NODE_VERSION=$1
    local BASE
    BASE=$(port_base_for "$NODE_VERSION") || return 1
    local ALL_HEALTHY=true

    echo ""
    echo "Health checks for Node.js $NODE_VERSION:"
    echo "----------------------------------------"

    check_service_health "Mock Service" "http://localhost:$((BASE + 1))/api/data" || ALL_HEALTHY=false
    check_service_health "Express + @nestjs/axios" "http://localhost:$((BASE + 2))/api" || ALL_HEALTHY=false
    check_service_health "Express + nestjs-axios-undici" "http://localhost:$((BASE + 3))/api" || ALL_HEALTHY=false
    check_service_health "Fastify + @nestjs/axios" "http://localhost:$((BASE + 4))/api" || ALL_HEALTHY=false
    check_service_health "Fastify + nestjs-axios-undici" "http://localhost:$((BASE + 5))/api" || ALL_HEALTHY=false
    check_service_health "Express + @nestjs/axios + interceptor" "http://localhost:$((BASE + 6))/api" || ALL_HEALTHY=false
    check_service_health "Express + nestjs-axios-undici + interceptor" "http://localhost:$((BASE + 7))/api" || ALL_HEALTHY=false
    check_service_health "Raw undici (floor)" "http://localhost:$((BASE + 8))/api" || ALL_HEALTHY=false

    if [ "$ALL_HEALTHY" = true ]; then
        echo -e "${GREEN}All services are healthy!${NC}"
        return 0
    else
        echo -e "${RED}Some services are not healthy!${NC}"
        return 1
    fi
}

# Function to get container logs for debugging
get_container_logs() {
    local COMPOSE_FILE=$1
    local SERVICE_NAME=$2
    
    echo ""
    echo "Logs for $SERVICE_NAME:"
    echo "----------------------------------------"
    docker compose -f $COMPOSE_FILE logs --tail=50 $SERVICE_NAME 2>&1
}

# Function to run test for a specific Node version
run_node_test() {
    local NODE_VERSION=$1
    local COMPOSE_FILE=$2
    local K6_SCRIPT=$3
    
    echo ""
    echo "======================================"
    echo "Testing with Node.js $NODE_VERSION"
    echo "======================================"
    
    # Stop any running containers
    echo "Stopping existing containers..."
    docker compose -f $COMPOSE_FILE down --remove-orphans
    
    # Start containers
    echo "Starting containers with Node.js $NODE_VERSION..."
    docker compose -f $COMPOSE_FILE up --build -d
    
    # Wait a bit for containers to initialize
    echo "Waiting for containers to initialize..."
    sleep 5
    
    # Perform health checks
    if ! check_all_services $NODE_VERSION; then
        echo -e "${YELLOW}Warning: Not all services are healthy. Checking logs...${NC}"
        
        # Get container names from docker compose
        echo ""
        echo "Container statuses:"
        docker compose -f $COMPOSE_FILE ps
        
        # Get logs for all services
        echo ""
        echo "Getting logs for all services..."
        docker compose -f $COMPOSE_FILE logs --tail=50
        
        echo ""
        echo -e "${YELLOW}Attempting to continue with test despite unhealthy services...${NC}"
        echo -e "${YELLOW}Results may be incomplete or invalid.${NC}"
        
        # Optional: Ask user if they want to continue
        read -p "Do you want to continue with the test? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Skipping test for Node.js $NODE_VERSION"
            docker compose -f $COMPOSE_FILE down
            return 1
        fi
    fi
    
    # Run k6 test
    echo ""
    echo "Running performance test..."
    if k6 run -e BENCHMARK_ENVIRONMENT="$BENCHMARK_ENVIRONMENT" -e LIBRARY_REF="$LIBRARY_REF" $K6_SCRIPT; then
        echo -e "${GREEN}Test completed successfully!${NC}"
    else
        echo -e "${RED}Test failed!${NC}"
    fi
    
    # Stop containers
    echo "Stopping containers..."
    docker compose -f $COMPOSE_FILE down
    
    echo ""
    return 0
}

# Main execution
echo "Starting comprehensive performance tests..."
echo ""

for NODE_VERSION in "${NODE_VERSIONS[@]}"; do
    if ! run_node_test "$NODE_VERSION" "$(compose_file_for "$NODE_VERSION")" "k6-scripts/test-node$NODE_VERSION.js"; then
        echo -e "${RED}Node.js $NODE_VERSION test failed or was skipped${NC}"
    fi
done

# Generate the docs page and both README headlines from the results just produced
if [ -f "generate-comparison-report.js" ]; then
    echo "======================================"
    echo "Generating Docs Page and Headlines"
    echo "======================================"
    node generate-comparison-report.js --docs ../docs/benchmarks.md
    node generate-comparison-report.js --headline ../README.md
    node generate-comparison-report.js --headline README.md
    echo ""
fi

# Display summary of available results
echo "======================================"
echo "Available Results"
echo "======================================"
echo ""

for file in results/*.json results/*.csv; do
    if [ -f "$file" ]; then
        echo "✓ $(basename "$file")"
    fi
done

echo ""
echo "======================================"
echo "All tests completed!"
echo "======================================"
echo ""
echo "Raw results are in the 'results' directory; the generated report is docs/benchmarks.md"