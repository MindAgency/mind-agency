#!/bin/bash
# E2E Test Runner
# Runs all end-to-end tests against a running server

set -e

echo "=== Mind Agency E2E Tests ==="
echo ""

# Check if server is running
if ! curl -s http://localhost:3000/api/health > /dev/null 2>&1; then
  echo "❌ Server not running on port 3000"
  echo "   Start with: npm run dev:all"
  exit 1
fi

echo "✅ Server is running"

# Run tests
echo ""
echo "Running E2E tests..."
npx vitest run tests/e2e/ --reporter=verbose

echo ""
echo "=== Done ==="
