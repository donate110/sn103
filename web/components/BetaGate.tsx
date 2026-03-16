"use client";

import { useState, useEffect } from "react";
import Image from "next/image";

export default function BetaGate({ children }: { children: React.ReactNode }) {
  const [authorized, setAuthorized] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    // Check server-side if the user already has beta access (via cookie)
    fetch("/api/beta/verify", { credentials: "same-origin" })
      .then((res) => res.json())
      .then((data) => {
        if (data.authorized) setAuthorized(true);
      })
      .catch(() => {
        // If the endpoint doesn't exist or fails, allow access (beta gate disabled)
        setAuthorized(true);
      })
      .finally(() => setChecking(false));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/beta/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
        credentials: "same-origin",
      });
      if (res.ok) {
        setAuthorized(true);
        setError(false);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    }
  };

  if (checking) {
    return null;
  }

  if (authorized) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center px-4">
      <div className="flex items-center gap-4 mb-4">
        <Image
          src="/djinn-logo.png"
          alt="Djinn"
          width={56}
          height={56}
          className="w-14 h-14"
        />
        <h1 className="text-5xl font-bold text-slate-900 font-wordmark tracking-wide">
          DJINN
        </h1>
      </div>
      <p className="text-sm tracking-[0.25em] uppercase text-slate-400 font-light">
        The Genius-Idiot Network
      </p>
      <p className="text-base text-slate-500 mt-1 mb-8">
        Information{" "}
        <span className="font-bold text-slate-900 mx-1">&times;</span>{" "}
        Execution
      </p>

      <div className="text-center mb-10 space-y-1">
        <p className="text-slate-600">
          Buy intelligence you can <span className="font-semibold text-slate-900">trust</span>.
        </p>
        <p className="text-slate-600">
          Sell analysis you can <span className="font-semibold text-slate-900">prove</span>.
        </p>
        <p className="text-sm text-idiot-500 italic mt-3">
          Signals stay secret forever. Even from us.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="w-full max-w-xs">
        <input
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(false);
          }}
          placeholder="Enter beta password"
          aria-label="Beta password"
          aria-invalid={error || undefined}
          className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 placeholder-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 transition-colors text-center"
          autoFocus
        />
        {error && (
          <p className="text-sm text-red-500 text-center mt-2" role="alert">
            Incorrect password
          </p>
        )}
        <button
          type="submit"
          className="w-full mt-4 rounded-lg bg-slate-900 px-4 py-3 text-sm font-medium text-white hover:bg-slate-800 transition-colors"
        >
          Enter
        </button>
      </form>

      <p className="text-xs text-slate-400 mt-8">
        Djinn is currently in private beta.
      </p>
    </div>
  );
}
