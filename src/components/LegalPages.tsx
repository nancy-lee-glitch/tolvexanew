import React, { useState } from 'react';

export type LegalTab = 'terms' | 'privacy' | 'risk' | 'cookies';

interface LegalPagesProps {
  initialTab?: LegalTab;
  onClose?: () => void;
  onBack?: () => void;
  onLaunchCockpit?: () => void;
}

export function LegalPages({ initialTab = 'terms', onClose, onBack, onLaunchCockpit }: LegalPagesProps) {
  const [activeTab, setActiveTab] = useState<LegalTab>(initialTab);
  const handleExit = onBack || onClose || onLaunchCockpit;

  return (
    <div className="max-w-4xl mx-auto space-y-6 font-mono text-xs animate-in fade-in duration-200">
      {/* Top Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-5 sm:p-6 shadow-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-slate-400" />
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Regulatory Transparency &amp; Compliance
            </span>
          </div>
          <h1 className="text-xl sm:text-2xl font-black text-white mt-1">
            Legal &amp; Policy Documentation
          </h1>
          <p className="text-slate-400 font-sans text-xs mt-1">
            Last Updated: October 2026 • Tolvexa Protocol &amp; Software Architecture
          </p>
        </div>

        <div className="flex items-center gap-2">
          {onLaunchCockpit && (
            <button
              type="button"
              onClick={onLaunchCockpit}
              className="py-2 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-bold transition border border-slate-700"
            >
              ← Cockpit
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold transition"
            >
              ✕ Close
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 border-b border-slate-800 text-xs">
        {[
          { id: 'terms', label: '📄 Terms of Service' },
          { id: 'privacy', label: '🔒 Privacy Policy' },
          { id: 'risk', label: '⚠️ Risk Disclosure' },
          { id: 'cookies', label: '🍪 Cookie Policy' },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id as LegalTab)}
            className={`py-2 px-4 rounded-xl transition font-bold whitespace-nowrap ${
              activeTab === tab.id
                ? 'bg-emerald-500 text-slate-950 font-black shadow-md shadow-emerald-500/20'
                : 'text-slate-400 hover:text-white hover:bg-slate-900'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content Container */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 sm:p-8 space-y-6 text-slate-300 font-sans text-xs sm:text-sm leading-relaxed">
        {/* TAB 1: TERMS OF SERVICE */}
        {activeTab === 'terms' && (
          <div className="space-y-4">
            <h2 className="text-base sm:text-lg font-bold text-white font-mono uppercase">
              1. Terms of Service
            </h2>
            <p>
              Welcome to <strong>Tolvexa</strong> (&ldquo;Software&rdquo;, &ldquo;Platform&rdquo;, or &ldquo;Service&rdquo;). By creating an
              account, generating signals, or accessing our algorithmic interfaces, you acknowledge and agree to be bound
              by these Terms of Service. If you disagree with any part of these terms, do not use the service.
            </p>

            <h3 className="text-xs sm:text-sm font-bold text-white font-mono uppercase pt-2">
              1.1 Nature of the Software
            </h3>
            <p>
              Tolvexa is a quantitative data analytics and mathematical indicator tool designed to assist retail traders
              in evaluating price momentum and statistical confluence. Tolvexa is <strong>not a broker, dealer, investment
              fund, or financial advisor</strong>. The platform does not hold, manage, or accept trading deposits. All trading
              decisions and financial transactions are executed exclusively on third-party broker platforms (e.g., Deriv,
              ExpertOption, MT5) at the user&rsquo;s sole risk and discretion.
            </p>

            <h3 className="text-xs sm:text-sm font-bold text-white font-mono uppercase pt-2">
              1.2 Age and Jurisdictional Eligibility
            </h3>
            <p>
              You must be at least 18 years of age (or the legal age of majority in your jurisdiction) to register an
              account. The Service is not directed to individuals residing in jurisdictions where trading fixed-odds contracts,
              binary options, or synthetic derivatives is prohibited by local law or regulation. You represent and warrant
              that your use of this software complies with all local laws and regulations applicable to you.
            </p>

            <h3 className="text-xs sm:text-sm font-bold text-white font-mono uppercase pt-2">
              1.3 Subscription, Credits &amp; Refunds
            </h3>
            <p>
              Starter credits and 30-Day VIP passes grant software access for computation and live feed consumption.
              Because digital software services and cryptocurrency transactions are consumed immediately upon activation,
              all token, crypto, and credit transactions are final and non-refundable once activated on the network.
            </p>

            <h3 className="text-xs sm:text-sm font-bold text-white font-mono uppercase pt-2">
              1.4 Disclaimer of Warranties
            </h3>
            <p>
              The platform is provided on an &ldquo;as is&rdquo; and &ldquo;as available&rdquo; basis without warranties of any kind.
              We make no representations or guarantees regarding win rates, system availability, or financial profit.
            </p>
          </div>
        )}

        {/* TAB 2: PRIVACY POLICY */}
        {activeTab === 'privacy' && (
          <div className="space-y-4">
            <h2 className="text-base sm:text-lg font-bold text-white font-mono uppercase">
              2. Privacy &amp; Data Protection Policy
            </h2>
            <p>
              Your privacy is fundamental to our engineering standards. This policy outlines how Tolvexa collects, uses,
              and protects user data across our platform.
            </p>

            <h3 className="text-xs sm:text-sm font-bold text-white font-mono uppercase pt-2">
              2.1 Data We Collect
            </h3>
            <ul className="list-disc pl-5 space-y-1.5 text-slate-400">
              <li><strong>Account Credentials:</strong> Username and email address provided during registration. Passwords are salted and hashed using bcrypt (cost factor 10) before storage; plaintext passwords are never stored or logged.</li>
              <li><strong>Telemetry &amp; Usage:</strong> Anonymous session timestamps, selected asset pairs, and credit balance state.</li>
              <li><strong>Network IP Metadata:</strong> Hashed IP addresses used strictly for rate limiting and sybil abuse mitigation.</li>
            </ul>

            <h3 className="text-xs sm:text-sm font-bold text-white font-mono uppercase pt-2">
              2.2 How We Use Your Data
            </h3>
            <p>
              Collected data is used solely to authenticate sessions, provide live WebSocket streams, deliver software updates,
              and prevent API exploitation. We do <strong>not sell, lease, or monetize</strong> your personal data to third-party advertisers or brokers.
            </p>

            <h3 className="text-xs sm:text-sm font-bold text-white font-mono uppercase pt-2">
              2.3 Data Storage &amp; Encryption
            </h3>
            <p>
              All traffic between your browser and our servers is secured with TLS 1.3 encryption. Backend database records
              are protected by Row Level Security (RLS) policies ensuring users cannot inspect or modify other accounts.
            </p>
          </div>
        )}

        {/* TAB 3: RISK DISCLOSURE */}
        {activeTab === 'risk' && (
          <div className="space-y-4">
            <h2 className="text-base sm:text-lg font-bold text-rose-400 font-mono uppercase flex items-center gap-2">
              <span>⚠️</span>
              <span>3. General &amp; Regulatory Risk Disclosure</span>
            </h2>

            <div className="p-4 rounded-2xl bg-rose-950/40 border border-rose-500/40 text-rose-200 text-xs font-mono">
              <strong>HIGH-RISK INVESTMENT WARNING:</strong> Trading binary options, contracts for difference (CFDs),
              cryptocurrencies, foreign exchange, and volatility synthetics carries a high level of risk and may not be
              suitable for all investors. The high degree of leverage and rapid expiration cycles can work against you as well as for you.
            </div>

            <h3 className="text-xs sm:text-sm font-bold text-white font-mono uppercase pt-2">
              3.1 Possibility of Total Loss
            </h3>
            <p>
              Before deciding to trade financial instruments or follow algorithmic signal telemetry, you should carefully
              consider your investment objectives, level of experience, and risk tolerance. You could sustain a loss of some
              or all of your deposited capital. <strong>Do not invest capital that you cannot afford to lose entirely.</strong>
            </p>

            <h3 className="text-xs sm:text-sm font-bold text-white font-mono uppercase pt-2">
              3.2 No Guarantees or Profit Assurances
            </h3>
            <p>
              Past performance, statistical models, and historical backtests displayed within Tolvexa do not guarantee or
              predict future results. Market regimes can shift suddenly due to economic news, central bank interventions,
              liquidity dry-ups, and structural volatility changes. The signals generated by this software represent mathematical
              probability estimates only and must never be interpreted as guarantees of profit.
            </p>

            <h3 className="text-xs sm:text-sm font-bold text-white font-mono uppercase pt-2">
              3.3 Execution Latency &amp; Broker Slippage
            </h3>
            <p>
              Market prices change by the millisecond. Latency between your internet connection and your selected broker
              may result in slippage between the strike price flagged by Tolvexa and the fill price executed on your broker desk.
            </p>
          </div>
        )}

        {/* TAB 4: COOKIE POLICY */}
        {activeTab === 'cookies' && (
          <div className="space-y-4">
            <h2 className="text-base sm:text-lg font-bold text-white font-mono uppercase">
              4. Cookie &amp; Local Storage Policy
            </h2>
            <p>
              Tolvexa utilizes modern client-side storage technologies, including cookies, <code>localStorage</code>, and
              <code>sessionStorage</code>, to provide a responsive and secure trading companion interface.
            </p>

            <h3 className="text-xs sm:text-sm font-bold text-white font-mono uppercase pt-2">
              4.1 Strictly Necessary Storage
            </h3>
            <p>
              These tokens are required for core platform functionality:
            </p>
            <ul className="list-disc pl-5 space-y-1.5 text-slate-400">
              <li><code>pulsetrade_session_token</code>: Authenticates your secure API session.</li>
              <li><code>pulsetrade_auth_user</code>: Caches your user profile state locally for zero-latency UI rendering.</li>
              <li><code>pulsetrade_selected_platform</code>: Remembers your active broker configuration.</li>
            </ul>

            <h3 className="text-xs sm:text-sm font-bold text-white font-mono uppercase pt-2">
              4.2 No Third-Party Ad Trackers
            </h3>
            <p>
              We do not employ cross-site tracking cookies, advertising beacons, or behavioral remarketing pixels.
              You may clear your browser cookies or local storage at any time via your browser settings.
            </p>
          </div>
        )}
      </div>

      {/* Footer Back Button */}
      <div className="flex justify-between items-center text-xs text-slate-500 font-mono pt-2">
        <span>Tolvexa Compliance Desk • Regulatory Standard ISO/IEC 27001</span>
        {onLaunchCockpit && (
          <button type="button" onClick={onLaunchCockpit} className="text-emerald-400 hover:underline">
            Return to Trading Cockpit →
          </button>
        )}
      </div>
    </div>
  );
}
