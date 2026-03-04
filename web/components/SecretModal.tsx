"use client";

import { useEffect } from "react";

interface SecretModalProps {
  open: boolean;
  title: string;
  message: string;
  variant?: "local" | "network" | "distribute";
  footer?: string;
  children?: React.ReactNode;
}

/**
 * Full-screen modal overlay for secret/sensitive operations.
 * Variant controls the icon, badge, and footer messaging:
 * - "local": lock icon, green badge, "Processing locally on your device"
 * - "network": globe icon, blue badge, "Checking network"
 * - "distribute": share icon, amber badge, "Distributing to validators"
 */
export default function SecretModal({ open, title, message, variant = "local", footer, children }: SecretModalProps) {
  // Prevent body scrolling when modal is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  if (!open) return null;

  const config = {
    local: {
      iconColor: "text-emerald-400",
      badgeBg: "bg-emerald-900/50 border-emerald-700/50",
      badgeText: "text-emerald-300",
      dotColor: "bg-emerald-400",
      spinnerColor: "border-emerald-500",
      badge: "Private — Local Only",
      defaultFooter: "Encrypted locally using AES-256. Your data never leaves this device.",
      icon: (
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
      ),
    },
    network: {
      iconColor: "text-blue-400",
      badgeBg: "bg-blue-900/50 border-blue-700/50",
      badgeText: "text-blue-300",
      dotColor: "bg-blue-400",
      spinnerColor: "border-blue-500",
      badge: "Checking network",
      defaultFooter: "Verifying your lines are available. Your pick is not shared.",
      icon: (
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5a17.92 17.92 0 01-8.716-2.247m0 0A9.015 9.015 0 003 12c0-1.605.42-3.113 1.157-4.418" />
      ),
    },
    distribute: {
      iconColor: "text-amber-400",
      badgeBg: "bg-amber-900/50 border-amber-700/50",
      badgeText: "text-amber-300",
      dotColor: "bg-amber-400",
      spinnerColor: "border-amber-500",
      badge: "Securing your pick",
      defaultFooter: "Your pick is being split up and stored safely across multiple independent parties. Nobody can see it.",
      icon: (
        <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z" />
      ),
    },
  }[variant];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Dark backdrop */}
      <div className="absolute inset-0 bg-slate-900/80 backdrop-blur-sm" />

      {/* Modal content */}
      <div className="relative mx-4 w-full max-w-md rounded-2xl bg-slate-900 border border-slate-700 p-8 text-center shadow-2xl">
        {/* Icon */}
        <div className="mx-auto mb-5 w-14 h-14 rounded-full bg-slate-800 border border-slate-600 flex items-center justify-center">
          <svg className={`w-7 h-7 ${config.iconColor}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            {config.icon}
          </svg>
        </div>

        {/* Badge */}
        <div className={`inline-flex items-center gap-1.5 rounded-full ${config.badgeBg} border px-3 py-1 mb-4`}>
          <span className={`w-1.5 h-1.5 rounded-full ${config.dotColor} animate-pulse`} />
          <span className={`text-xs font-medium ${config.badgeText}`}>{config.badge}</span>
        </div>

        <h2 className="text-lg font-semibold text-white mb-2">{title}</h2>
        <p className="text-sm text-slate-400 mb-6">{message}</p>

        {/* Spinner */}
        <div className="flex justify-center mb-4">
          <div className={`w-8 h-8 border-2 ${config.spinnerColor} border-t-transparent rounded-full animate-spin`} />
        </div>

        {children}

        <p className="text-xs text-slate-500 mt-4">
          {footer ?? config.defaultFooter}
        </p>
      </div>
    </div>
  );
}
