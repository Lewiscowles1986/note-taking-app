import { AlertTriangle } from "lucide-react";

interface PreviewBannerProps {
  branch?: string;
  storageIsolation: boolean;
}

/**
 * Dismiss-free top banner shown only on PR preview builds (VITE_PREVIEW=true).
 * Its whole purpose is to make it obvious the user is NOT using the real app:
 * amber warning styling, the source branch, and a note that storage is isolated
 * so the preview can't touch production data.
 */
export default function PreviewBanner({ branch, storageIsolation }: PreviewBannerProps) {
  return (
    <div
      role="alert"
      className="flex h-8 shrink-0 items-center justify-center gap-2 bg-amber-400 px-4 text-[11px] font-semibold text-amber-950"
    >
      <AlertTriangle size={14} aria-hidden />
      <span>PREVIEW BUILD</span>
      <span aria-hidden>·</span>
      <span className="truncate">
        {branch ? (
          <>
            branch <span className="rounded bg-amber-500/30 px-1">«{branch}»</span>
          </>
        ) : (
          "not the real app"
        )}
      </span>
      {storageIsolation && (
        <>
          <span aria-hidden>·</span>
          <span>storage isolated</span>
        </>
      )}
    </div>
  );
}
