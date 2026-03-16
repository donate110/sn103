"use client";

import { useEffect } from "react";

interface PrivateWorkspaceProps {
  open: boolean;
  onClose?: () => void;
  children: React.ReactNode;
}

/**
 * Full-screen modal overlay for private/local-only workflows (signal creation, ZKP).
 * Dark backdrop with lock branding in header/footer. Content renders inside a
 * white floating card — visually distinct from the main site, like a wallet-connect popup.
 */
export default function PrivateWorkspace({ open, onClose, children }: PrivateWorkspaceProps) {
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] flex flex-col">
      {/* Dark backdrop */}
      <div className="absolute inset-0 bg-slate-900/90 backdrop-blur-sm" />

      {/* Floating card container */}
      <div className="relative flex flex-col w-full h-full max-w-4xl mx-auto py-4 px-4 sm:px-6">
        {/* Header bar — lock branding + close */}
        <div className="shrink-0 flex items-center justify-between px-4 py-3 rounded-t-xl bg-slate-900 border border-slate-700/80 border-b-0">
          <div className="flex items-center gap-3">
            {/* Lock icon */}
            <div className="w-8 h-8 rounded-full bg-slate-800 border border-slate-600 flex items-center justify-center">
              <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
              </svg>
            </div>
            {/* Badge */}
            <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-900/50 border border-emerald-700/50 px-3 py-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span className="text-xs font-medium text-emerald-300">Private, Local Only</span>
            </div>
          </div>

          {onClose && (
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-white transition-colors p-1"
              aria-label="Close"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* White content card — scrollable */}
        <div className="flex-1 overflow-y-auto bg-white border-x border-slate-200 px-5 py-6 sm:px-8">
          {children}
        </div>

        {/* Footer */}
        <div className="shrink-0 rounded-b-xl bg-slate-900 border border-slate-700/80 border-t-0 px-4 py-2.5 flex items-center justify-center gap-2">
          <svg className="w-3.5 h-3.5 text-emerald-500/70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
          </svg>
          <span className="text-xs text-slate-400">Your data stays on this device. Nothing is shared until you submit on-chain.</span>
        </div>
      </div>
    </div>
  );
}
