import { NextResponse } from 'next/server';

/**
 * Health check endpoint for load balancers, monitoring, and deployment verification.
 *
 * Returns 200 with basic service info when the dashboard is healthy.
 */
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'x402-dashboard',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
  });
}
