"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ArtifactPanel } from "@/components/ArtifactPanel";
import type { Artifact } from "@/components/ArtifactPanel";

interface ArtifactContextValue {
  open: (artifact: Artifact) => void;
  close: () => void;
}

const ArtifactContext = createContext<ArtifactContextValue | null>(null);

/**
 * Holds the currently open artifact. A single panel is rendered at the root so
 * only one can be open at a time, and any code block anywhere in the
 * conversation can open it without prop drilling.
 */
export function ArtifactProvider({ children }: { children: ReactNode }) {
  const [artifact, setArtifact] = useState<Artifact | null>(null);

  const open = useCallback((a: Artifact) => setArtifact(a), []);
  const close = useCallback(() => setArtifact(null), []);

  const value = useMemo(() => ({ open, close }), [open, close]);

  return (
    <ArtifactContext.Provider value={value}>
      {children}
      {artifact && <ArtifactPanel artifact={artifact} onClose={close} />}
    </ArtifactContext.Provider>
  );
}

export function useArtifact(): ArtifactContextValue {
  const ctx = useContext(ArtifactContext);
  if (!ctx) {
    throw new Error("useArtifact must be used within an ArtifactProvider");
  }
  return ctx;
}
