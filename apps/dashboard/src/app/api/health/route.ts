import { NextResponse } from 'next/server';

/**
 * Health check endpoint for Docker health checks and monitoring.
 * Returns 200 when the dashboard is running and responsive.
 */
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'x402-dashboard',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
}
