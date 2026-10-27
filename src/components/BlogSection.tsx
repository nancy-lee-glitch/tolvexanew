import React, { useState } from 'react';
import type { BlogArticle } from '../types.ts';
import { BLOG_ARTICLES } from '../data/blogArticles.ts';
import { SafeImage } from './SafeImage.tsx';

interface BlogSectionProps {
  selectedArticle: BlogArticle | null;
  onSelectArticle: (article: BlogArticle | null) => void;
  onGetStarted: () => void;
  onLaunchCockpit: () => void;
}

export function BlogSection({
  selectedArticle,
  onSelectArticle,
  onGetStarted,
  onLaunchCockpit,
}: BlogSectionProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [copiedLink, setCopiedLink] = useState(false);

  const categories = ['ALL', 'Quantitative Alpha', 'Risk Management', 'Technical Strategy', 'Market Mechanics'];

  const filteredArticles = selectedCategory === 'ALL'
    ? BLOG_ARTICLES
    : BLOG_ARTICLES.filter((a) => a.category === selectedCategory);

  const handleCopyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  // FULL ARTICLE VIEW
  if (selectedArticle) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        {/* Back Navigation */}
        <button
          type="button"
          onClick={() => onSelectArticle(null)}
          className="inline-flex items-center gap-2 text-xs font-mono text-emerald-400 hover:text-emerald-300 font-bold hover:underline"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to Quantitative Academy
        </button>

        {/* Article Header */}
        <div className="space-y-4 font-mono">
          <div className="inline-block bg-emerald-950/80 border border-emerald-500/40 text-emerald-400 text-xs px-3 py-1 rounded-full font-bold">
            {selectedArticle.category}
          </div>
          <h1 className="text-2xl sm:text-4xl font-black text-white leading-tight">
            {selectedArticle.title}
          </h1>

          <div className="flex flex-wrap items-center justify-between gap-4 py-3 border-y border-slate-800 text-xs text-slate-400">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 font-bold text-sm">
                {selectedArticle.author.charAt(0)}
              </div>
              <div>
                <div className="text-white font-bold">{selectedArticle.author}</div>
                <div className="text-[11px] text-slate-500">{selectedArticle.authorRole}</div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <span>{selectedArticle.date}</span>
              <span>•</span>
              <span>{selectedArticle.readTime}</span>
              <span>•</span>
              <button
                type="button"
                onClick={handleCopyLink}
                className="text-slate-300 hover:text-white px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 transition"
              >
                {copiedLink ? '✓ Copied' : 'Share'}
              </button>
            </div>
          </div>
        </div>

        {/* Hero Image */}
        <div className="aspect-[16/9] w-full rounded-3xl overflow-hidden border border-slate-800">
          <SafeImage
            src={selectedArticle.imageUrl}
            alt={selectedArticle.title}
            fallbackTitle={selectedArticle.title}
            className="w-full h-full object-cover"
          />
        </div>

        {/* Key Takeaways Box */}
        <div className="bg-slate-900 border-2 border-emerald-500/40 rounded-3xl p-6 space-y-3 font-mono">
          <div className="flex items-center gap-2 text-emerald-400 text-xs uppercase tracking-wider font-bold">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Key Quantitative Takeaways
          </div>
          <ul className="space-y-2">
            {selectedArticle.keyTakeaways.map((takeaway, i) => (
              <li key={i} className="text-xs text-slate-300 flex items-start gap-2">
                <span className="text-emerald-400 font-bold">•</span>
                <span>{takeaway}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Article Body */}
        <div className="prose prose-invert max-w-none space-y-5 text-sm sm:text-base text-slate-300 leading-relaxed font-sans">
          {selectedArticle.content.map((paragraph, index) => (
            <p key={index} className="leading-relaxed">
              {paragraph}
            </p>
          ))}
        </div>

        {/* Article Tags */}
        <div className="flex flex-wrap gap-2 pt-4 border-t border-slate-800 font-mono text-xs">
          <span className="text-slate-500 self-center">Filed Under:</span>
          {selectedArticle.tags.map((tag) => (
            <span
              key={tag}
              className="bg-slate-900 border border-slate-800 text-slate-300 px-2.5 py-1 rounded-lg"
            >
              #{tag}
            </span>
          ))}
        </div>

        {/* In-Article CTA Banner */}
        <div className="bg-gradient-to-r from-emerald-950/90 via-slate-900 to-slate-900 border border-emerald-500/40 rounded-3xl p-6 sm:p-8 space-y-4 font-mono">
          <div className="space-y-1">
            <h3 className="text-lg font-black text-white">Apply This Research with PulseTrade Pro</h3>
            <p className="text-xs text-slate-400">
              Test these exact latency principles in real-time with 10 free starter signal credits.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={onGetStarted}
              className="py-2.5 px-5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded-xl transition"
            >
              Claim 10 Free Credits &rarr;
            </button>
            <button
              type="button"
              onClick={onLaunchCockpit}
              className="py-2.5 px-4 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs rounded-xl transition"
            >
              Launch Live Cockpit
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ARTICLES LIST VIEW
  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-10">
      {/* Blog Header */}
      <div className="text-center space-y-3 max-w-2xl mx-auto">
        <span className="text-xs font-mono font-bold uppercase text-emerald-400 tracking-widest">
          Quantitative Trading Academy
        </span>
        <h1 className="text-2xl sm:text-4xl font-black text-white font-mono">
          Research, Market Mechanics &amp; Execution Edge
        </h1>
        <p className="text-xs sm:text-sm text-slate-400">
          In-depth algorithmic analysis of binary options pricing, order-flow velocity, latency arbitrage, and capital survival.
        </p>
      </div>

      {/* Category Pills */}
      <div className="flex flex-wrap justify-center gap-2 font-mono text-xs">
        {categories.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setSelectedCategory(cat)}
            className={`px-3.5 py-1.5 rounded-xl border transition ${
              selectedCategory === cat
                ? 'bg-emerald-500 text-slate-950 border-emerald-400 font-bold shadow-md shadow-emerald-500/20'
                : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-white hover:border-slate-700'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Articles Grid */}
      <div className="grid md:grid-cols-2 gap-6">
        {filteredArticles.map((article) => (
          <article
            key={article.id}
            className="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden hover:border-slate-700 transition flex flex-col justify-between group"
          >
            <div>
              <div className="relative aspect-[16/9] w-full overflow-hidden">
                <SafeImage
                  src={article.imageUrl}
                  alt={article.title}
                  fallbackTitle={article.title}
                  className="w-full h-full object-cover group-hover:scale-105 transition duration-500"
                />
                <div className="absolute top-3 left-3 bg-slate-950/90 backdrop-blur border border-slate-700 text-emerald-400 text-[10px] font-mono px-2.5 py-1 rounded-lg">
                  {article.category}
                </div>
              </div>

              <div className="p-5 sm:p-6 space-y-3">
                <div className="flex items-center gap-2 text-[11px] font-mono text-slate-400">
                  <span>{article.date}</span>
                  <span>•</span>
                  <span>{article.readTime}</span>
                  <span>•</span>
                  <span className="text-slate-300">{article.author}</span>
                </div>

                <h2 className="text-lg font-bold text-white group-hover:text-emerald-400 transition font-mono leading-snug">
                  {article.title}
                </h2>

                <p className="text-xs text-slate-400 line-clamp-3 leading-relaxed">
                  {article.excerpt}
                </p>
              </div>
            </div>

            <div className="px-5 pb-5 sm:px-6 sm:pb-6 pt-2 flex items-center justify-between border-t border-slate-800/80 font-mono text-xs">
              <div className="flex flex-wrap gap-1.5">
                {article.tags.slice(0, 2).map((tag) => (
                  <span
                    key={tag}
                    className="bg-slate-950 text-slate-400 text-[10px] px-2 py-0.5 rounded border border-slate-800"
                  >
                    #{tag}
                  </span>
                ))}
              </div>
              <button
                type="button"
                onClick={() => onSelectArticle(article)}
                className="text-emerald-400 hover:text-emerald-300 font-bold hover:underline flex items-center gap-1"
              >
                Read Article &rarr;
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
