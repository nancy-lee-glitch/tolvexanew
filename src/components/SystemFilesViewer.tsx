import React, { useState } from 'react';

const SYSTEM_FILES = [
  { name: 'schema.sql', path: '/schema.sql', type: 'SQL' },
  { name: 'config.php', path: '/config.php', type: 'PHP' },
  { name: 'index.php', path: '/index.php', type: 'PHP' },
  { name: 'create_payment.php', path: '/create_payment.php', type: 'PHP' },
  { name: 'webhook_nowpayments.php', path: '/webhook_nowpayments.php', type: 'PHP' },
  { name: 'admin.php', path: '/admin.php', type: 'PHP' },
  { name: 'heartbeat.php', path: '/heartbeat.php', type: 'PHP' },
  { name: 'api.php', path: '/api.php', type: 'PHP' },
  { name: 'register.php', path: '/register.php', type: 'PHP' },
  { name: 'login.php', path: '/login.php', type: 'PHP' },
];

export function SystemFilesViewer() {
  const [selectedFile, setSelectedFile] = useState(SYSTEM_FILES[0]);
  const [fileContent, setFileContent] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);

  const loadContent = async (file: (typeof SYSTEM_FILES)[0]) => {
    setSelectedFile(file);
    setLoading(true);
    try {
      const res = await fetch(file.path);
      const text = await res.text();
      setFileContent(text);
    } catch (e) {
      setFileContent('// Error loading file stream');
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => {
    loadContent(SYSTEM_FILES[0]);
  }, []);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-2xl space-y-4 font-mono">
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div>
          <h3 className="text-sm font-bold text-white uppercase tracking-wider">System Deliverables & Architecture</h3>
          <span className="text-[10px] text-slate-400">Zero-Placeholder Production Source Inspection</span>
        </div>
        <a
          href={selectedFile.path}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-cyan-400 hover:text-cyan-300 underline flex items-center gap-1"
        >
          <span>Raw Source: {selectedFile.name}</span>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      </div>

      {/* File Badges */}
      <div className="flex flex-wrap gap-1.5">
        {SYSTEM_FILES.map((f) => (
          <button
            key={f.name}
            type="button"
            onClick={() => loadContent(f)}
            className={`py-1 px-2.5 rounded-lg text-xs font-mono transition ${
              selectedFile.name === f.name
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/50 font-bold'
                : 'bg-slate-950 border border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            {f.name}
          </button>
        ))}
      </div>

      {/* Code Box */}
      <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-3 max-h-96 overflow-y-auto">
        {loading ? (
          <div className="text-slate-500 text-xs text-center py-8">Loading source stream...</div>
        ) : (
          <pre className="text-[11px] text-slate-300 font-mono whitespace-pre-wrap leading-relaxed">
            {fileContent}
          </pre>
        )}
      </div>
    </div>
  );
}
