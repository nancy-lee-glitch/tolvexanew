import React from 'react';
import type { SiteSettings } from '../types.ts';

interface FloatingSupportFABProps {
  settings: SiteSettings;
}

export function FloatingSupportFAB({ settings }: FloatingSupportFABProps) {
  const whatsappUrl = (settings.supportWhatsapp || '').trim();
  const telegramUrl = (settings.supportTelegram || '').trim();

  // If neither link is configured, render nothing
  if (!whatsappUrl && !telegramUrl) {
    return null;
  }

  return (
    <div
      aria-label="Community Support Channels"
      className="fixed bottom-24 sm:bottom-6 right-3 sm:right-5 z-40 flex flex-col items-end gap-2.5 pointer-events-auto"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      {/* WhatsApp Button */}
      {whatsappUrl && (
        <a
          href={whatsappUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Chat on WhatsApp"
          className="group relative flex items-center justify-center w-11 h-11 sm:w-12 sm:h-12 rounded-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-xl shadow-emerald-500/30 hover:scale-105 active:scale-95 transition-all duration-200 border border-emerald-300/40"
        >
          {/* Tooltip on Desktop hover */}
          <span className="hidden sm:group-hover:inline-block absolute right-14 bg-slate-900 border border-slate-700 text-white text-[11px] font-mono py-1 px-2.5 rounded-lg whitespace-nowrap shadow-md pointer-events-none">
            WhatsApp Support
          </span>
          <svg className="w-5 h-5 sm:w-6 sm:h-6 fill-current" viewBox="0 0 24 24">
            <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-5.805 1.554zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z" />
          </svg>
        </a>
      )}

      {/* Telegram Button */}
      {telegramUrl && (
        <a
          href={telegramUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Join Telegram Channel"
          className="group relative flex items-center justify-center w-11 h-11 sm:w-12 sm:h-12 rounded-full bg-sky-500 hover:bg-sky-400 text-white shadow-xl shadow-sky-500/30 hover:scale-105 active:scale-95 transition-all duration-200 border border-sky-300/40"
        >
          {/* Tooltip on Desktop hover */}
          <span className="hidden sm:group-hover:inline-block absolute right-14 bg-slate-900 border border-slate-700 text-white text-[11px] font-mono py-1 px-2.5 rounded-lg whitespace-nowrap shadow-md pointer-events-none">
            Telegram Community
          </span>
          <svg className="w-5 h-5 sm:w-6 sm:h-6 fill-current" viewBox="0 0 24 24">
            <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221l-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.446 1.394c-.14.18-.357.295-.6.295-.002 0-.003 0-.005 0l.213-3.054 5.56-5.022c.24-.213-.054-.334-.373-.121l-6.869 4.326-2.96-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.196 1.006.128.832.922z" />
          </svg>
        </a>
      )}
    </div>
  );
}
