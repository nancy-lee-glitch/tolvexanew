import React, { useState } from 'react';

export interface SafeImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string;
  alt?: string;
  className?: string;
  fallbackTitle?: string;
}

export function SafeImage({ src, alt, className = '', fallbackTitle, ...props }: SafeImageProps) {
  const [hasError, setHasError] = useState(false);

  if (hasError || !src) {
    return (
      <div
        className={`bg-gradient-to-tr from-slate-900 via-slate-800 to-emerald-950/40 border border-slate-800 flex flex-col items-center justify-center text-center p-4 select-none ${className}`}
      >
        <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mb-2">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
        </div>
        <span className="text-xs font-mono font-bold text-slate-300 line-clamp-1">
          {fallbackTitle || alt || 'Quantitative Analytics'}
        </span>
        <span className="text-[10px] font-mono text-emerald-400 mt-0.5">Verified Telemetry Feed</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt || 'Trading Chart'}
      referrerPolicy="no-referrer"
      onError={() => setHasError(true)}
      className={className}
      {...props}
    />
  );
}
