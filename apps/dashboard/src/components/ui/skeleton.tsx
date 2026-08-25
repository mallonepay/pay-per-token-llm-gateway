"use client";

import { cn } from "@/lib/utils";

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "text" | "circular" | "rectangular";
  width?: string | number;
  height?: string | number;
}

export function Skeleton({
  className,
  variant = "text",
  width,
  height,
  ...props
}: SkeletonProps) {
  return (
    <div
      className={cn(
        "animate-pulse bg-gray-200 rounded",
        variant === "circular" && "rounded-full",
        variant === "rectangular" && "rounded-lg",
        className
      )}
      style={{ width, height, minWidth: width, minHeight: height }}
      {...props}
    />
  );
}

export function TableSkeleton({ rows = 5, columns = 4 }) {
  return (
    <div className="space-y-3">
      {/* Header skeleton */}
      <div className="grid gap-4 p-4" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} variant="text" height={16} width="80%" />
        ))}
      </div>
      {/* Row skeletons */}
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div
          key={rowIndex}
          className="grid gap-4 p-4 border-t border-gray-100"
          style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
        >
          {Array.from({ length: columns }).map((_, colIndex) => (
            <Skeleton
              key={colIndex}
              variant="text"
              height={16}
              width={colIndex === 0 ? "60%" : "80%"}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
      <div className="flex items-center gap-4">
        <Skeleton variant="circular" width={48} height={48} />
        <div className="space-y-2 flex-1">
          <Skeleton variant="text" width="40%" height={20} />
          <Skeleton variant="text" width="60%" height={14} />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4 pt-4 border-t border-gray-100">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="space-y-1">
            <Skeleton variant="text" width="50%" height={12} />
            <Skeleton variant="text" width="80%" height={24} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ChartSkeleton({ height = 300 }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <div className="space-y-3 mb-6">
        <Skeleton variant="text" width="30%" height={24} />
        <Skeleton variant="text" width="50%" height={14} />
      </div>
      <Skeleton variant="rectangular" width="100%" height={height} />
    </div>
  );
}

export function StatCardSkeleton() {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <Skeleton variant="text" width="40%" height={14} className="mb-2" />
      <Skeleton variant="text" width="60%" height={32} className="mb-2" />
      <Skeleton variant="text" width="30%" height={12} />
    </div>
  );
}