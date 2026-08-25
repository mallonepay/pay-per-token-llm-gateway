"use client";

import { useFetch } from "@/lib/hooks";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { RefreshCw, ExternalLink, Search, Filter } from "lucide-react";
import { useState } from "react";

interface Route {
  id: string;
  name: string;
  path: string;
  upstreamUrl: string;
  pricePerRequest: string;
  isActive: boolean;
  createdAt: string;
  requestCount: number;
  totalRevenue: string;
}

interface RoutesResponse {
  routes: Route[];
  total: number;
  page: number;
  pageSize: number;
}

function RoutesContent() {
  const { data, error, isLoading, refetch } = useFetch<RoutesResponse>("/admin/routes");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");

  const filteredRoutes = data?.routes.filter((route) => {
    const matchesSearch =
      route.name.toLowerCase().includes(search.toLowerCase()) ||
      route.path.toLowerCase().includes(search.toLowerCase());
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "active" && route.isActive) ||
      (statusFilter === "inactive" && !route.isActive);
    return matchesSearch && matchesStatus;
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton variant="text" width="30%" height={28} />
          <Skeleton variant="text" width="150px" height={40} />
        </div>
        <TableSkeleton rows={5} columns={7} />
      </div>
    );
  }

  if (error) {
    // Error is handled by ErrorBoundary
    throw error;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Routes</h1>
          <p className="text-gray-500 mt-1">Manage your API routes and pricing</p>
        </div>
        <Button onClick={refetch} variant="outline" className="gap-2">
          <RefreshCw className="w-4 h-4" />
          Refresh
        </Button>
      </div>

      <div className="bg-white rounded-lg border border-gray-200">
        <div className="p-4 border-b border-gray-200 flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search routes..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
          >
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Path</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Upstream</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Price/Req</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Requests</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Revenue</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {filteredRoutes?.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-gray-500">
                    No routes found
                  </td>
                </tr>
              ) : (
                filteredRoutes?.map((route) => (
                  <tr key={route.id} className="hover:bg-gray-50">
                    <td className="px-4 py-4 font-medium text-gray-900">{route.name}</td>
                    <td className="px-4 py-4 text-gray-500 font-mono text-sm">{route.path}</td>
                    <td className="px-4 py-4 text-gray-500 truncate max-w-xs">{route.upstreamUrl}</td>
                    <td className="px-4 py-4 text-gray-900">${route.pricePerRequest}</td>
                    <td className="px-4 py-4">
                      <span
                        className={
                          `inline-flex px-2 py-1 text-xs font-semibold rounded-full $
                            {route.isActive
                              ? "bg-green-100 text-green-800"
                              : "bg-gray-100 text-gray-800"}
                          `}
                      >
                        {route.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-gray-500">{route.requestCount.toLocaleString()}</td>
                    <td className="px-4 py-4 text-gray-900">${route.totalRevenue}</td>
                    <td className="px-4 py-4">
                      <a
                        href={`/routes/${route.id}`}
                        className="text-primary hover:underline text-sm"
                      >
                        View Details
                      </a>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {data && (
          <div className="p-4 border-t border-gray-200 flex items-center justify-between">
            <p className="text-sm text-gray-500">
              Showing {filteredRoutes?.length || 0} of {data.total} routes
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={data.page === 1}
                onClick={() => {}}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={data.page * data.pageSize >= data.total}
                onClick={() => {}}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function RoutesPage() {
  return (
    <div className="p-6">
      <ErrorBoundary>
        <RoutesContent />
      </ErrorBoundary>
    </div>
  );
}

// Need to import Skeleton for the loading state
import { Skeleton } from "@/components/ui/skeleton";
