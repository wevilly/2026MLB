import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getGetAnalystPitcherLabQueryKey, getGetAnalystPlayerLabQueryKey, getGetHistoricalIntelligenceCoverageQueryKey, useGetAnalystDataHealth, useGetAnalystMarketResearch, useGetAnalystProjections, useGetAnalystSettings, useGetAnalystToday, useRefreshFantasyPros, useRefreshMlbOfficial, useGetAnalystPlayerLab, useGetAnalystPitcherLab, useGetAnalystGameLab, useRefreshAnalystResearch, useGetAnalystBullpenRoom, useRefreshBullpen, useRefreshMarketResearchTB, useRefreshMarketResearchXBH, useRefreshMarketResearchWALK, useRefreshMarketResearchHR, useCaptureFeatureStoreSlate, useBackfillFeatureStore, useGetAnalystFeatureStore, useGetAnalystDailyMarketBoard, useGetAnalystDailyBoardGameSummary, useRefreshAnalystDailyMarketBoard, useGetAnalystBettorEvaluation, useChatWithAnalystAi, useGetAnalystAiDrafts, useCreateAnalystAiDraft, useApproveAnalystAiDraft, useRejectAnalystAiDraft, useGetAnalystAiSourcingRegister, useDecideAnalystAiSourcingClaim, useGetAnalystAiResearchNotes, useGetHistoricalIntelligenceCoverage } from '@workspace/api-client-react';
import type { AnalystSettings, BackfillFeatureStoreParams, BullpenArm, BullpenRoom, BullpenTeam, CaptureFeatureStoreSlateParams, DataHealth, FeatureStoreCaptureResult, FeatureStoreResult, HealthIssue, HREngineResult, MarketResearchCandidate, PregameFeatureSnapshot, ProjectionCenter, ProjectionRow, SlateGame, SourceBadge, TBEngineResult, XBHEngineResult, WALKEngineResult, TodayDashboard, ResearchMetric, ResearchSearchResult, ResearchProfile, DailyMarketBoard, DailyBoardGameSummary, BettorEvaluation, BettorEvaluationPickMarket, WeatherRefreshResult, HistoricalIntelligenceCoverage } from '@workspace/api-client-react';
import { Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3, Bell, BookOpen, CalendarDays, Check, ChevronRight, Cloud, Database, Gauge, GitBranch, Home, LineChart, LockKeyhole, Menu, RefreshCw, Server, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Table2, Target, X, Search, ArrowRight, Send, FilePlus, ThumbsDown, ThumbsUp, ExternalLink, ClipboardList, Download, Play, Square } from 'lucide-react';
import { Link, Route, Switch, useLocation, useSearch, Router as WouterRouter } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';

import RoundRobinPage from './pages/round-robin-page';

const queryClient = new QueryClient();

export type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'accent';
type MarketShortCode = MarketResearchCandidate['market'];
type SettledMarketShortCode = Exclude<MarketShortCode, 'H_R_RBI'>;

function currentEasternDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

const navGroups: { label: string; items: Array<{ href: string; label: string; icon: typeof Home; future?: boolean }> }[] = [
  {
    label: 'Operations',
    items: [
      { href: '/', label: 'Today', icon: Home },
      { href: '/projection-center', label: 'Projection center', icon: LineChart },
      { href: '/data-health', label: 'Data health', icon: Database },
      { href: '/orchestration', label: 'Orchestration', icon: ClipboardList },
      { href: '/audit-trail', label: 'Audit trail', icon: BookOpen },
    ],
  },
  {
    label: 'Labs',
    items: [
      { href: '/game-lab', label: 'Game lab', icon: CalendarDays },
      { href: '/player-lab', label: 'Player lab', icon: Target },
      { href: '/pitcher-lab', label: 'Pitcher lab', icon: Activity },
      { href: '/bullpen-room', label: 'Bullpen room', icon: ShieldCheck },
      { href: '/market-board', label: 'Market board', icon: BarChart3 },
      { href: '/round-robin', label: 'Round robin', icon: Database },
      { href: '/bettor-intelligence', label: 'Bettor intelligence', icon: Gauge },
      { href: '/model-lab', label: 'Model lab', icon: GitBranch, future: true },
      { href: '/ai-analyst', label: 'AI analyst', icon: Sparkles },
      { href: '/results', label: 'Results', icon: Table2, future: true },
    ],
  },
];

export function toneFor(value: string | null | undefined): Tone {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized.includes('not configured') || normalized.includes('not run') || normalized.includes('error') || normalized.includes('fail') || normalized.includes('missing') || normalized.includes('blocked') || normalized.includes('critical') || normalized.includes('unavailable')) return 'bad';
  if (normalized.includes('warn') || normalized.includes('stale') || normalized.includes('partial') || normalized.includes('pending') || normalized.includes('degraded') || normalized.includes('audit')) return 'warn';
  if (normalized.includes('good') || normalized.includes('ready') || normalized.includes('fresh') || normalized.includes('healthy') || normalized.includes('complete') || normalized.includes('configured') || normalized.includes('active')) return 'good';
  return 'neutral';
}

export function StatusDot({ tone = 'neutral', pulse = false }: { tone?: Tone; pulse?: boolean }) {
  return <span className={`status-dot status-${tone} ${pulse ? 'status-pulse' : ''}`} aria-hidden="true" />;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`badge badge-${tone}`} data-testid="status-badge">{children}</span>;
}

export function Panel({ children, className = '', ...props }: { children: ReactNode; className?: string; [key: string]: unknown }) {
  return <section className={`panel ${className}`} {...props}>{children}</section>;
}

export function Kicker({ children }: { children: ReactNode }) {
  return <div className="kicker">{children}</div>;
}

export function SectionHeading({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="section-heading">
      <div>
        <Kicker>{eyebrow}</Kicker>
        <h2>{title}</h2>
        {detail && <p>{detail}</p>}
      </div>
      {action}
    </div>
  );
}

export function LoadingPanel({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" data-testid="loading-state">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="skeleton h-16 w-full rounded-sm" />
      ))}
    </div>
  );
}

export function QueryMessage({ kind, onRetry }: { kind: 'error' | 'empty'; onRetry?: () => void }) {
  if (kind === 'error') {
    return (
      <div className="query-message query-error" data-testid="error-state">
        <div className="query-icon"><AlertTriangle size={18} /></div>
        <div><strong>Signal unavailable</strong><p>The analyst service did not return a usable payload.</p></div>
        {onRetry && <button className="button button-quiet ml-auto" onClick={onRetry} data-testid="button-retry"><RefreshCw size={14} /> Retry</button>}
      </div>
    );
  }
  return (
    <div className="query-message" data-testid="empty-state">
      <div className="query-icon"><Database size={18} /></div>
      <div><strong>No records in this view</strong><p>Once the source publishes a payload, it will appear here.</p></div>
    </div>
  );
}

function Metric({ label, value, note, tone = 'neutral' }: { label: string; value: ReactNode; note: string; tone?: Tone }) {
  return (
    <div className="metric" data-testid={`metric-${label.toLowerCase().replaceAll(' ', '-')}`}>
      <span className="metric-label">{label}</span>
      <strong className={tone === 'accent' ? 'text-accent' : ''}>{value}</strong>
      <span className="metric-note"><StatusDot tone={tone} /> {note}</span>
    </div>
  );
}

function SourceRow({ source, compact = false }: { source: SourceBadge; compact?: boolean }) {
  const tone = toneFor(source.status);
  return (
    <div className={`source-row ${compact ? 'source-row-compact' : ''}`} data-testid={`source-row-${source.name.replaceAll(' ', '-').toLowerCase()}`}>
      <div className="source-mark"><Server size={15} /></div>
      <div className="min-w-0 flex-1">
        <div className="source-title"><strong>{source.name}</strong><Badge tone={tone}>{source.status}</Badge></div>
        <p className="truncate">{source.detail}</p>
      </div>
      <div className="source-meta">
        <span>{source.freshness}</span>
        <small>effective {source.effectiveDate ?? 'not reported'} · {source.ageMinutes === null ? 'age unavailable' : `${source.ageMinutes}m old`}</small>
        {!compact && <small>{source.rowCount.toLocaleString()} rows</small>}
      </div>
    </div>
  );
}

export function ReadinessStrip({ health, sources }: { health?: { readiness: DataHealth['readiness']; sources?: SourceBadge[] }; sources?: SourceBadge[] }) {
  const readiness = health?.readiness;
  const contextSources = sources ?? health?.sources ?? [];
  if (!readiness) {
    return <div className="readiness-strip readiness-unavailable"><AlertTriangle size={15} /><div><strong>Current-date readiness unavailable</strong><p>No health contract was returned, so this view cannot be treated as operational.</p></div></div>;
  }
  const tone = toneFor(readiness.status);
  return (
    <section className={`readiness-strip readiness-${tone}`} data-testid="current-readiness">
      <div className="readiness-main">
        <StatusDot tone={tone} pulse={readiness.status === 'PARTIAL'} />
        <div><Kicker>Current Eastern-date health</Kicker><strong>{readiness.status}</strong><p>{readiness.reason}</p></div>
      </div>
      <div className="readiness-meta">
        <span><b>Current</b> {readiness.currentDate}</span>
        <span><b>Observed</b> {new Date(readiness.observedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })} ET</span>
        {/* AUDIT_ONLY specifically means "not the current Eastern slate date".
            Labelling PARTIAL and BLOCKED as "audit-only" too misstated why
            outputs were unavailable, so show the real status instead. */}
        <span><b>Operational</b> {readiness.usable ? 'usable' : readiness.status === 'AUDIT_ONLY' ? 'audit-only' : `not operational (${readiness.status.toLowerCase()})`}</span>
      </div>
      <div className="readiness-sources" aria-label="Source freshness context">
        {contextSources.map((source) => <span key={source.name} className={`readiness-source source-${toneFor(source.status)}`}><b>{source.name}</b> {source.effectiveDate ?? 'no date'} · {source.ageMinutes === null ? 'age —' : `${source.ageMinutes}m`} · {source.isCurrentDate ? 'current' : 'not current'}</span>)}
      </div>
    </section>
  );
}

function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const healthQuery = useGetAnalystDataHealth();
  const readiness = healthQuery.data?.readiness;
  const railStatus = healthQuery.isError ? 'UNAVAILABLE' : readiness?.status ?? 'CHECKING';
  const railTone = healthQuery.isError ? 'bad' : toneFor(railStatus);
  const pageTitle = useMemo(() => navGroups.flatMap((group) => group.items).find((item) => item.href === location)?.label ?? 'Analyst platform', [location]);

  return (
    <div className="app-noise min-h-[100dvh]">
      <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
        <div className="brand-block">
          <div className="brand-mark">M</div>
          <div><strong>MLB / OPS</strong><span>Analyst platform</span></div>
          <button className="mobile-close" onClick={() => setMobileOpen(false)} data-testid="button-close-navigation"><X size={18} /></button>
        </div>
        <div className="rail-status"><StatusDot tone={railTone} pulse={railStatus === 'PARTIAL' || railStatus === 'CHECKING'} /><span>{railStatus}</span><small>{readiness?.currentDate ?? 'HEALTH CHECK'}</small></div>
        <nav className="side-nav" aria-label="Primary navigation">
          {navGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-label">{group.label}</div>
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = location === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    className={`nav-item ${active ? 'nav-active' : ''}`}
                    data-testid={`link-${item.label.replaceAll(' ', '-').toLowerCase()}`}
                  >
                    <Icon size={16} strokeWidth={active ? 2.2 : 1.8} />
                    <span>{item.label}</span>
                    {item.future && <span className="future-mark">F2</span>}
                    {active && <ChevronRight size={14} className="nav-chevron" />}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <Link href="/settings" className={`settings-link ${location === '/settings' ? 'nav-active' : ''}`} data-testid="link-settings"><Settings2 size={16} /> <span>Settings</span></Link>
          <div className="version-mark"><span>Data contracts locked</span><code>v0.1 / read-only</code></div>
        </div>
      </aside>
      {mobileOpen && <button className="mobile-backdrop" onClick={() => setMobileOpen(false)} aria-label="Close navigation" data-testid="button-navigation-backdrop" />}
      <main className="main-shell">
        <header className="topbar">
          <div className="topbar-left">
            <button className="mobile-menu" onClick={() => setMobileOpen(true)} data-testid="button-open-navigation"><Menu size={20} /></button>
            <div className="breadcrumb"><span>OPERATIONS ROOM</span><ChevronRight size={13} /><strong>{pageTitle.toUpperCase()}</strong></div>
          </div>
          <div className="topbar-right">
            <div className="live-clock"><StatusDot tone={railTone} /> {railStatus} <span className="clock-divider">/</span> {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })} ET</div>
            <Link href="/settings" className="topbar-icon" data-testid="link-topbar-settings"><SlidersHorizontal size={17} /></Link>
            <div className="analyst-avatar" data-testid="text-analyst-avatar">AN</div>
          </div>
        </header>
        <div className="page-wrap">{children}</div>
      </main>
    </div>
  );
}

function DashboardPage() {
  const query = useGetAnalystToday();
  const refreshMlb = useRefreshMlbOfficial({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['getAnalystToday'] });
        queryClient.invalidateQueries({ queryKey: ['getAnalystDataHealth'] });
      },
    },
  });
  const data = query.data as TodayDashboard | undefined;
  const flaggedGames = data?.games?.filter((game) => game.flag).length ?? 0;
  const freshSources = data?.sources?.filter((source) => toneFor(source.status) === 'good').length ?? 0;
  const activeCoverage = data?.identityCoverage
    ? `${data.identityCoverage.activeProjectionPlayersMapped}/${data.identityCoverage.activeProjectionPlayersTotal}`
    : '0/0';

  return (
    <div className="page-content rise-in">
      <div className="page-intro">
        <div><Kicker>{data ? `${data.date} / ${data.timezone.replace('/', ' / ')}` : 'Slate date / timezone'}</Kicker><h1>Today <span className="slash">//</span> slate control</h1><p>One clean surface for the day’s inputs, provenance, and open questions.</p></div>
        <button className="button button-dark" onClick={() => refreshMlb.mutate({})} disabled={refreshMlb.isPending} data-testid="button-refresh-slate"><RefreshCw size={15} /> {refreshMlb.isPending ? 'Ingesting official MLB…' : 'Refresh official MLB'}</button>
      </div>
      {query.isLoading ? <LoadingPanel rows={5} /> : query.isError ? <QueryMessage kind="error" onRetry={() => query.refetch()} /> : !data ? <QueryMessage kind="empty" /> : (
        <>
          <ReadinessStrip health={{ readiness: data.readiness, sources: data.sources }} sources={data.sources} />
          <div className="metric-grid">
            <Metric label="Games on slate" value={data.games?.length ?? 0} note={`${data.timezone} window`} tone="accent" />
            <Metric label="Flags to resolve" value={flaggedGames} note={flaggedGames ? 'Review before lock' : 'No open flags'} tone={flaggedGames ? 'warn' : 'good'} />
            <Metric label="Sources online" value={`${freshSources}/${data.sources?.length ?? 0}`} note="Fresh or ready" tone={freshSources === data.sources?.length ? 'good' : 'warn'} />
            <Metric label="Current identities" value={activeCoverage} note={data?.identityCoverage?.blockingProjectedLineupIssues ? `${data.identityCoverage.blockingProjectedLineupIssues} lineup block(s)` : 'Eligible projection coverage'} tone={data?.identityCoverage?.blockingProjectedLineupIssues ? 'bad' : 'good'} />
            <Metric label="Alerts" value={data.alerts?.length ?? 0} note="System observations" tone={data.alerts?.length ? 'warn' : 'good'} />
          </div>
          <div className="dashboard-layout">
            <Panel className="slate-panel">
              <SectionHeading eyebrow="Current slate" title="Game board" detail={`${data.games?.length ?? 0} games / lineup and starter state shown inline`} action={<button className="icon-button" onClick={() => query.refetch()} aria-label="Refresh game board" data-testid="button-refresh-game-board"><RefreshCw size={15} /></button>} />
              {data.games?.length ? <div className="game-list">{data.games.map((game) => <GameCard game={game} key={game.id} />)}</div> : <QueryMessage kind="empty" />}
            </Panel>
            <div className="dashboard-side">
              <Panel>
                <SectionHeading eyebrow="Source state" title="Inputs in view" detail="Status is reported by the ingest layer." />
                <div className="source-list">{data.sources?.length ? data.sources.map((source) => <SourceRow source={source} key={source.name} />) : <QueryMessage kind="empty" />}</div>
                <Link href="/data-health" className="panel-link" data-testid="link-view-data-health">Open data health <ArrowUpRight size={14} /></Link>
              </Panel>
              <Panel className="alert-panel">
                <SectionHeading eyebrow="Analyst notices" title="Open observations" />
                {data.alerts?.length ? <ul className="alert-list">{data.alerts.map((alert, index) => <li key={`${alert}-${index}`} data-testid={`alert-${index}`}><AlertTriangle size={14} /><span>{alert}</span></li>)}</ul> : <div className="clear-state"><Check size={16} /> No active observations</div>}
              </Panel>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function GameCard({ game }: { game: SlateGame }) {
  const readinessTone = toneFor(game.state);
  return (
    <article className="game-card" data-testid={`card-game-${game.id}`}>
      <div className="game-card-top"><span className="game-time">{game.time}</span><Badge tone={readinessTone}>{game.state}</Badge><span className="game-id">{game.id}</span></div>
      <div className="matchup"><div><strong>{game.away}</strong><span>{game.awayStarter.name} <i>{game.awayStarter.hand}</i></span></div><div className="at-mark">@</div><div className="home-team"><strong>{game.home}</strong><span>{game.homeStarter.name} <i>{game.homeStarter.hand}</i></span></div></div>
      <div className="game-details"><span><Cloud size={13} /> {game.weather}</span><span><Home size={13} /> {game.roof}</span><span><span className="diamond-mark" /> {game.park}</span><span className="lineup-state"><StatusDot tone={toneFor(game.lineupState)} /> {game.lineupState}</span></div>
      {(game.flag || game.awayStarter.note || game.homeStarter.note) && <div className="starter-note"><Bell size={13} /> <span>{game.flag || game.awayStarter.note || game.homeStarter.note}</span></div>}
    </article>
  );
}

function ProjectionsPage() {
  const query = useGetAnalystProjections();
  const refreshFantasyPros = useRefreshFantasyPros({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['getAnalystProjections'] });
        queryClient.invalidateQueries({ queryKey: ['getAnalystToday'] });
        queryClient.invalidateQueries({ queryKey: ['getAnalystDataHealth'] });
      },
    },
  });
  const data = query.data as ProjectionCenter | undefined;
  return (
    <div className="page-content rise-in">
      <div className="page-intro">
        <div><Kicker>FantasyPros / immutable snapshot</Kicker><h1>Projection <span className="slash">//</span> center</h1><p>Source components are visible. Market probabilities and confidence grades are intentionally unavailable before validation.</p></div>
        <button className="button button-dark" onClick={() => refreshFantasyPros.mutate({})} disabled={refreshFantasyPros.isPending} data-testid="button-refresh-projections"><RefreshCw size={15} /> {refreshFantasyPros.isPending ? 'Ingesting FantasyPros…' : 'Ingest FantasyPros'}</button>
      </div>
      {query.isLoading ? <LoadingPanel rows={7} /> : query.isError ? <QueryMessage kind="error" onRetry={() => query.refetch()} /> : !data ? <QueryMessage kind="empty" /> : (
        <>
          <Panel className="snapshot-banner">
            <div><Kicker>Active snapshot</Kicker><strong>{data.snapshotLabel}</strong></div>
            <div className="snapshot-times"><div><span>Effective date</span><strong>{data.effectiveDate.slice(0, 10)}</strong></div><div><span>Current as of</span><strong>{data.currentAsOf}</strong></div><div><span>Prior as of</span><strong>{data.priorAsOf ?? 'Not available'}</strong></div></div>
            <Badge tone="good"><StatusDot tone="good" /> Reproducible view</Badge>
          </Panel>
          <Panel className="projection-panel">
            <SectionHeading eyebrow="Latest current-date source components" title="Four-market foundation" detail={`${data.uniqueEligiblePlayers ?? 0} unique players · ${data.uniqueEligibleHitters ?? 0} hitters / ${data.uniqueEligiblePitchers ?? 0} pitchers · ${data.rows?.length ?? 0} component rows`} action={<button className="icon-button" onClick={() => refreshFantasyPros.mutate({})} disabled={refreshFantasyPros.isPending} aria-label="Ingest FantasyPros projection table" data-testid="button-refresh-projection-table"><RefreshCw size={15} /></button>} />
            {data.rows?.length ? <ProjectionTable rows={data.rows} /> : <QueryMessage kind="empty" />}
          </Panel>
          <Panel className="notes-panel"><div className="notes-title"><BookOpen size={16} /><Kicker>System notes</Kicker></div>{data.systemNotes?.length ? <div className="notes-grid">{data.systemNotes.map((note, index) => <div key={`${note}-${index}`} data-testid={`system-note-${index}`}><span>0{index + 1}</span><p>{note}</p></div>)}</div> : <p className="muted-copy">No notes attached to this snapshot.</p>}</Panel>
        </>
      )}
    </div>
  );
}

function ProjectionTable({ rows }: { rows: ProjectionRow[] }) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead><tr><th>Player</th><th>Team</th><th>Pos</th><th>Market</th><th className="number">Source component</th><th className="number">Prior</th><th>State</th><th>As of</th></tr></thead>
        <tbody>{rows.map((row, index) => {
          const direction = row.movement.toLowerCase().includes('down') || row.movement.includes('-') ? 'down' : row.movement.toLowerCase().includes('flat') ? 'flat' : 'up';
          return <tr key={`${row.player}-${index}`} data-testid={`row-projection-${index}`}><td><strong>{row.player}</strong></td><td><span className="team-chip">{row.team}</span></td><td>{row.position}</td><td className="market-cell">{row.market}</td><td className="number value-current">{row.current}</td><td className="number value-prior">{row.prior ?? '—'}</td><td><span className={`movement movement-${direction}`}>{direction === 'up' ? <ArrowUpRight size={13} /> : direction === 'down' ? <ArrowDownRight size={13} /> : <span className="movement-flat">—</span>}{row.movement}</span></td><td className="asof-cell">{row.asOf}</td></tr>;
        })}</tbody>
      </table>
    </div>
  );
}

function DataHealthPage() {
  const [date, setDate] = useState(currentEasternDate());
  const query = useGetAnalystDataHealth({ date });
  const data = query.data as DataHealth | undefined;
  const criticalCount = data?.issues?.filter((issue) => toneFor(issue.severity) === 'bad').length ?? 0;
  const coverage = data?.identityCoverage;
  return (
    <div className="page-content rise-in">
      <div className="page-intro">
        <div><Kicker>Provenance / freshness / mappings</Kicker><h1>Data <span className="slash">//</span> health</h1><p>Know what arrived, when it arrived, and what still needs an analyst’s eyes.</p></div>
        <div className="flex gap-2 flex-wrap"><input className="search-input !w-auto" type="date" value={date} onChange={(event) => setDate(event.target.value)} /><button className="button button-dark" onClick={() => query.refetch()} data-testid="button-refresh-data-health"><RefreshCw size={15} /> Run health check</button></div>
      </div>
      {query.isLoading ? <LoadingPanel rows={6} /> : query.isError ? <QueryMessage kind="error" onRetry={() => query.refetch()} /> : !data ? <QueryMessage kind="empty" /> : (
        <>
          <ReadinessStrip health={data} />
          <div className="health-summary">
            <Panel className="overall-panel"><div className="health-ring"><Gauge size={25} /><span>{data.overall}</span></div><div><Kicker>{data.selectedDate} / {data.timezone}</Kicker><h2>{data.overall}</h2><p>{data.slateState.replaceAll('_', ' ')} · Last run {data.lastRun}</p></div><div className="health-rule" /></Panel>
            <Metric label="Sources observed" value={data.sources?.length ?? 0} note="In current health run" tone="accent" />
            <Metric label="Issues requiring review" value={(data.issues?.length ?? 0) >= 50 ? '50+' : data.issues?.length ?? 0} note={(data.issues?.length ?? 0) >= 50 ? 'List capped at 50; totals may be higher' : criticalCount ? `${criticalCount} critical` : 'No critical issues in list'} tone={criticalCount ? 'bad' : data.issues?.length ? 'warn' : 'good'} />
          </div>
          <Panel><SectionHeading eyebrow="Selected-date readiness" title="Operational stage diagnostics" detail="Each stage is evaluated against the selected Eastern slate date." /><div className="issue-list">{data.readinessDiagnostics.map((diagnostic) => <IssueRow key={diagnostic.code} issue={{ label: diagnostic.label, detail: diagnostic.detail, severity: diagnostic.status === 'READY' ? 'INFO' : 'CRITICAL' }} />)}</div></Panel>
          <Panel>
              <SectionHeading eyebrow="Current player eligibility" title="Slate identity coverage" detail="Pregame research is driven by FantasyPros projected lineups. MLB posted cards arrive later and remain confirmation/audit context only." />
            <div className="metric-grid">
              <Metric label="Official starters" value={`${coverage?.officialStartersMapped ?? 0}/${coverage?.officialStartersTotal ?? 0}`} note="Canonical identities" tone={(coverage?.officialStartersMapped ?? 0) === (coverage?.officialStartersTotal ?? 0) ? 'good' : 'bad'} />
              <Metric label="MLB posted cards" value={(coverage?.officialLineupPlayersTotal ?? 0) === 0 ? 'N/A' : `${coverage?.officialLineupPlayersMapped ?? 0}/${coverage?.officialLineupPlayersTotal ?? 0}`} note={(coverage?.officialLineupPlayersTotal ?? 0) === 0 ? 'LATE CONFIRMATION NOT YET AVAILABLE' : 'Audit and settlement lineage only'} tone={(coverage?.officialLineupPlayersTotal ?? 0) === 0 ? 'neutral' : (coverage?.officialLineupPlayersMapped ?? 0) === (coverage?.officialLineupPlayersTotal ?? 0) ? 'good' : 'bad'} />
              <Metric label="Projected lineups" value={`${coverage?.projectedLineupPlayersMapped ?? 0}/${coverage?.projectedLineupPlayersTotal ?? 0}`} note={coverage?.blockingProjectedLineupIssues ? `${coverage.blockingProjectedLineupIssues} blocking issue(s)` : 'Active pregame research input'} tone={coverage?.blockingProjectedLineupIssues ? 'bad' : 'good'} />
              <Metric label="Active projections" value={`${coverage?.activeProjectionPlayersMapped ?? 0}/${coverage?.activeProjectionPlayersTotal ?? 0}`} note={`${coverage?.unresolvedActivePlayers ?? 0} unresolved active`} tone={(coverage?.unresolvedActivePlayers ?? 0) ? 'warn' : 'good'} />
              <Metric label="Quarantined rows" value={coverage?.quarantinedRows ?? 0} note="Raw rows retained for audit" tone={(coverage?.quarantinedRows ?? 0) ? 'warn' : 'good'} />
              <Metric label="Team conflicts" value={coverage?.teamAssignmentConflicts ?? 0} note="Source team vs official org" tone={(coverage?.teamAssignmentConflicts ?? 0) ? 'warn' : 'good'} />
            </div>
          </Panel>
          <Panel>
            <SectionHeading eyebrow="Research layer" title="Analyst lab metrics" detail="Evidence, profiles, and analytical lab data quality." />
            <div className="metric-grid">
              {/* A zero denominator means the eligible universe itself is
                  missing — vacuously "0 missing evidence" must not read as
                  healthy green. */}
              <Metric label="Hitter evidence" value={`${data.researchHealth?.playerProfiles ?? 0}/${data.researchHealth?.eligibleHitterProfiles ?? 0}`} note={(data.researchHealth?.eligibleHitterProfiles ?? 0) === 0 ? 'No eligible hitter universe recorded for this date' : `${data.researchHealth?.hitterProfilesMissingEvidence ?? 0} eligible shells lack source evidence`} tone={(data.researchHealth?.eligibleHitterProfiles ?? 0) === 0 ? 'warn' : (data.researchHealth?.hitterProfilesMissingEvidence ?? 0) > 0 ? 'warn' : 'good'} />
              <Metric label="Pitcher evidence" value={`${data.researchHealth?.pitcherProfiles ?? 0}/${data.researchHealth?.eligiblePitcherProfiles ?? 0}`} note={(data.researchHealth?.eligiblePitcherProfiles ?? 0) === 0 ? 'No eligible pitcher universe recorded for this date' : `${data.researchHealth?.pitcherProfilesMissingEvidence ?? 0} eligible shells lack source evidence`} tone={(data.researchHealth?.eligiblePitcherProfiles ?? 0) === 0 ? 'warn' : (data.researchHealth?.pitcherProfilesMissingEvidence ?? 0) > 0 ? 'warn' : 'good'} />
              <Metric label="Park contexts" value={`${data.researchHealth?.parkProfiles ?? 0}/${data.researchHealth?.parkRequiredVenues ?? 0}`} note={`${data.researchHealth?.parkVenueCoverageGaps ?? 0} current-game venue gap(s) across All/L/R raw components`} tone={(data.researchHealth?.parkVenueCoverageGaps ?? 0) > 0 ? 'bad' : 'good'} />
              <Metric label="Stale windows" value={data.researchHealth?.staleWindows ?? 0} note="Requires refresh" tone={(data.researchHealth?.staleWindows ?? 0) > 0 ? 'warn' : 'good'} />
              <Metric label="Quarantined records" value={data.researchHealth?.identityQuarantines ?? 0} note="ID mapping failed" tone={(data.researchHealth?.identityQuarantines ?? 0) > 0 ? 'bad' : 'good'} />
              <Metric label="Insufficient samples" value={data.researchHealth?.insufficientSamples ?? 0} note="Statistically suppressed" tone={(data.researchHealth?.insufficientSamples ?? 0) > 0 ? 'warn' : 'good'} />
              <Metric label="Opponent-hand splits" value={`${data.researchHealth?.handednessCoveredPlayers ?? 0}/${data.researchHealth?.handednessTargetPlayers ?? 0}`} note={(data.researchHealth?.handednessTargetPlayers ?? 0) === 0 ? 'No split-target universe recorded for this date' : 'Full official eligible hitter/pitcher universe; explicit L/R Statcast panels'} tone={(data.researchHealth?.handednessTargetPlayers ?? 0) === 0 ? 'warn' : (data.researchHealth?.missingHandednessSplits ?? 0) > 0 ? 'bad' : 'good'} />
              <Metric label="Definition conflicts" value={data.researchHealth?.metricDefinitionConflicts ?? 0} note="Formula mismatch" tone={(data.researchHealth?.metricDefinitionConflicts ?? 0) > 0 ? 'bad' : 'good'} />
            </div>
          </Panel>
          <Panel>
            <SectionHeading eyebrow="Supplemental enrichment" title="Latest weather refresh" detail="FantasyPros slate weather is captured during lineup ingest. This retry is only for supplemental Open-Meteo coverage and never blocks the slate." />
            {data.weatherRefresh ? (
              <div className="metric-grid">
                <Metric label="Outcome" value={data.weatherRefresh.status} note={`Attempted ${new Date(data.weatherRefresh.startedAt).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`} tone={toneFor(data.weatherRefresh.status)} />
                <Metric label="Games found" value={data.weatherRefresh.gamesFound} note={`${data.weatherRefresh.observationsWritten} observation(s) written`} tone={data.weatherRefresh.observationsWritten ? 'good' : toneFor(data.weatherRefresh.status)} />
                <Metric label="Coverage failures" value={data.weatherRefresh.failures} note={data.weatherRefresh.error ?? 'No weather retrieval failures recorded'} tone={data.weatherRefresh.failures ? toneFor(data.weatherRefresh.status) : 'good'} />
              </div>
            ) : <div className="clear-state clear-large"><Cloud size={16} /> No weather refresh has been recorded for this slate date.</div>}
          </Panel>
          <div className="health-layout">
            <Panel><SectionHeading eyebrow="Ingest inventory" title="Source freshness" detail="Rows are reported, not estimated." /><div className="health-source-list">{data.sources?.length ? data.sources.map((source) => <HealthSource source={source} key={source.name} />) : <QueryMessage kind="empty" />}</div></Panel>
            <Panel><SectionHeading eyebrow="Data quality queue" title="Issues & mappings" detail="Unresolved items stay visible until cleared." />{data.issues?.length ? <div className="issue-list">{data.issues.map((issue, index) => <IssueRow issue={issue} key={`${issue.label}-${index}`} />)}</div> : <div className="clear-state clear-large"><Check size={16} /> Data quality queue is clear</div>}</Panel>
          </div>
        </>
      )}
    </div>
  );
}

type OrchestrationRun = {
  runId: string;
  runDate: string;
  triggeredBy: string;
  overallStatus: string;
  steps: Array<{ name: string; status: string; startedAt: string | null; finishedAt: string | null; detail: string | null }>;
  frozenAt: string | null;
  errorMessage: string | null;
};
type OperatorApproval = { authorized: boolean; expiresAt: string | null; detail: string };

async function operationsRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error ?? response.statusText);
  return response.json() as Promise<T>;
}

function OrchestrationPage() {
  const today = currentEasternDate();
  const [date, setDate] = useState(today);
  const [runs, setRuns] = useState<OrchestrationRun[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [messageKind, setMessageKind] = useState<'info' | 'error'>('info');
  const [loading, setLoading] = useState(false);
  const healthQuery = useGetAnalystDataHealth({ date });
  const [approvalKey, setApprovalKey] = useState('');
  const [approval, setApproval] = useState<OperatorApproval>({ authorized: false, expiresAt: null, detail: 'Checking operator approval…' });
  const [clock, setClock] = useState(Date.now());
  const approvalRemaining = approval.expiresAt ? Math.max(0, Date.parse(approval.expiresAt) - clock) : 0;
  const approvalActive = approval.authorized && approvalRemaining > 0;
  const loadApproval = async () => {
    try { setApproval(await operationsRequest<OperatorApproval>('/analyst/operations/operator-session')); }
    catch { setApproval({ authorized: false, expiresAt: null, detail: 'Operator approval status could not be checked.' }); }
  };
  const load = async (completionMessage?: string) => {
    setLoading(true);
    if (!completionMessage) setMessage(null);
    try {
      const response = await operationsRequest<{ runs: OrchestrationRun[] }>(`/analyst/orchestration/runs?date=${date}`);
      setRuns(response.runs);
      if (completionMessage) {
        setMessageKind('info');
        setMessage(completionMessage);
      }
    } catch (error) {
      setMessageKind('error');
      setMessage(error instanceof Error ? error.message : 'Unable to load orchestration history.');
    }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [date]);
  useEffect(() => { void loadApproval(); }, []);
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);
  const unlock = async () => {
    if (!approvalKey.trim()) return;
    setLoading(true);
    try {
      const next = await operationsRequest<{ expiresAt: string }>('/analyst/operations/operator-session', { method: 'POST', body: JSON.stringify({ approvalKey }) });
      setApprovalKey('');
      setApproval({ authorized: true, expiresAt: next.expiresAt, detail: 'Operator approval is active.' });
      setMessageKind('info');
      setMessage('Operator approval is active. Routine slate operations are now available until the displayed expiry time.');
    } catch (error) {
      setMessageKind('error');
      setMessage(error instanceof Error ? error.message : 'Unable to unlock operator actions.');
    }
    finally { setLoading(false); }
  };
  const startRun = async () => {
    setLoading(true);
    setMessageKind('info');
    setMessage('Starting the daily run…');
    try {
      const run = await operationsRequest<OrchestrationRun>(`/analyst/orchestration/run?date=${date}`, { method: 'POST' });
      await load(`Daily run accepted · run ${run.runId.slice(0, 8)} is running in the background.`);
    } catch (error) {
      setMessageKind('error');
      setMessage(error instanceof Error ? error.message : 'Unable to start run.');
    }
    finally { setLoading(false); }
  };
  const interrupt = async (runId: string) => {
    await operationsRequest(`/analyst/orchestration/runs/${runId}/interrupt`, { method: 'POST' });
    await load();
  };
  const lateScratchScan = async () => {
    setLoading(true);
    try {
      const result = await operationsRequest<{ corrections: number }>(`/analyst/orchestration/late-scratches?date=${date}`, { method: 'POST' });
      await load(result.corrections ? `${result.corrections} late-scratch correction(s) recorded and the board refreshed.` : 'No post-freeze scratches require correction.');
    } catch (error) {
      setMessageKind('error');
      setMessage(error instanceof Error ? error.message : 'Late-scratch scan failed.');
    }
    finally { setLoading(false); }
  };
  const retryWeather = async () => {
    setLoading(true);
    setMessageKind('info');
    setMessage(`Retrying optional weather enrichment for ${date}…`);
    try {
      const result = await operationsRequest<WeatherRefreshResult>(`/analyst/refresh/weather?date=${date}`, { method: 'POST' });
      const coverage = `${result.observationsWritten}/${result.gamesFound} observation(s) written`;
      setMessageKind(result.status === 'FAILED' ? 'error' : 'info');
      setMessage(
        result.status === 'SUCCESS'
          ? `Weather refresh succeeded for ${date}: ${coverage}. No model, engine, or unrelated ingest work was run.`
          : `Weather refresh completed with partial coverage for ${date}: ${coverage}; ${result.failures.length} issue(s) recorded. No model, engine, or unrelated ingest work was run.`,
      );
    } catch (error) {
      setMessageKind('error');
      setMessage(error instanceof Error ? error.message : 'Weather refresh failed. The attempt has been recorded in Data Health.');
    } finally {
      await healthQuery.refetch();
      setLoading(false);
    }
  };
  const refreshLedger = () => {
    setLoading(true);
    setMessageKind('info');
    setMessage('Refreshing the run ledger…');
    window.setTimeout(() => {
      void load('Run ledger refreshed.');
    }, 0);
  };
  return <div className="page-content rise-in" data-testid="page-orchestration">
    <div className="page-intro">
      <div><Kicker>Daily refresh control</Kicker><h1>Slate <span className="slash">//</span> orchestration</h1><p>One auditable sequence for ingest, research, market build, health checks, and the pregame freeze.</p></div>
      <div className="flex gap-2 flex-wrap"><input className="search-input !w-auto" type="date" value={date} onChange={(event) => setDate(event.target.value)} /><button className="button button-dark" disabled={loading || !approvalActive} onClick={startRun} data-testid="button-start-orchestration"><Play size={15} /> {loading ? 'Working…' : 'Run slate'}</button></div>
    </div>
    <ReadinessStrip health={healthQuery.data} />
    <Panel className="mb-6"><div className="flex flex-wrap justify-between gap-3 items-center"><div><Kicker>Operations approval</Kicker><strong>{approvalActive ? `Active · ${Math.ceil(approvalRemaining / 60000)} minute(s) remaining` : 'Routine actions locked'}</strong><p className="text-xs text-muted-foreground mt-1">{approval.detail}</p></div><div className="flex gap-2 flex-wrap"><input className="search-input !w-auto" type="password" value={approvalKey} onChange={(event) => setApprovalKey(event.target.value)} placeholder="Operator approval key" aria-label="Operator approval key" data-testid="input-operations-approval-key" /><button className="button button-dark" disabled={loading || !approvalKey.trim()} onClick={() => void unlock()}>{approvalActive ? 'Renew unlock' : 'Unlock operations'}</button></div></div></Panel>
     <Panel className="mb-6"><div className="flex flex-wrap justify-between gap-3 items-center"><div><Kicker>Schedule policy</Kicker><strong>08:00 ET refresh · freeze 90 minutes before the earliest first pitch</strong><p className="text-xs text-muted-foreground mt-1">Manual runs are recorded separately; feature snapshots remain append-only once frozen.</p></div><div className="flex gap-2 flex-wrap"><button className="button button-quiet" onClick={() => void lateScratchScan()} disabled={loading || !approvalActive}>Scan late scratches</button><button className="button button-quiet" onClick={refreshLedger} disabled={loading}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> {loading ? 'Refreshing…' : 'Refresh'}</button><a className="button button-quiet" href={`/api/analyst/export/slate-json?date=${date}`} target="_blank" rel="noreferrer"><Download size={15} /> slate.json</a><a className="button button-quiet" href={`/api/analyst/export/workbook?date=${date}`}><Download size={15} /> Workbook</a></div></div></Panel>
     <Panel className="mb-6"><div className="flex flex-wrap justify-between gap-3 items-center"><div><Kicker>Supplemental enrichment</Kicker><strong>Open-Meteo weather retry</strong><p className="text-xs text-muted-foreground mt-1">FantasyPros weather is captured with projected lineups. This retries only supplemental Open-Meteo forecasts for this Eastern slate date and does not rerun engines, training, validation, promotion, or other ingestion.</p>{healthQuery.data?.weatherRefresh && <p className="text-xs text-muted-foreground mt-2">Latest supplemental outcome: <strong>{healthQuery.data.weatherRefresh.status}</strong> · {healthQuery.data.weatherRefresh.observationsWritten}/{healthQuery.data.weatherRefresh.gamesFound} observations · {healthQuery.data.weatherRefresh.failures} failure(s)</p>}</div><button className="button button-quiet" disabled={loading || !approvalActive} onClick={() => void retryWeather()} data-testid="button-retry-weather"><Cloud size={15} /> {loading ? 'Retrying…' : 'Retry Open-Meteo'}</button></div></Panel>
     {message && <div className={`query-message mb-4 ${messageKind === 'error' ? 'query-error' : ''}`} role="status" data-testid="orchestration-message">{messageKind === 'error' ? <AlertTriangle size={16} /> : <Check size={16} />}<div><strong>{messageKind === 'error' ? 'Operator error' : 'Operator note'}</strong><p>{message}</p></div></div>}
    {runs.length === 0 && !loading ? <QueryMessage kind="empty" /> : <div className="space-y-4">
      {runs.map((run) => <Panel key={run.runId} className="p-5" data-testid={`orchestration-run-${run.runId}`}>
        <div className="flex justify-between gap-3 flex-wrap items-start"><div><Kicker>{run.triggeredBy} · {run.runDate}</Kicker><h2 className="text-lg">Run {run.runId.slice(0, 8)} <Badge tone={toneFor(run.overallStatus)}>{run.overallStatus}</Badge></h2><p className="text-xs text-muted-foreground mt-1">Frozen: {run.frozenAt ?? 'not yet'} {run.errorMessage ? `· ${run.errorMessage}` : ''}</p></div>{run.overallStatus === 'RUNNING' && <button className="button button-quiet" disabled={!approvalActive} onClick={() => void interrupt(run.runId)}><Square size={14} /> Interrupt</button>}</div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3 mt-4">{run.steps.map((step) => <div className="border border-border p-3 text-xs min-w-0" key={step.name}><div className="flex justify-between gap-2"><strong>{step.name.replaceAll('_', ' ')}</strong><Badge tone={toneFor(step.status)}>{step.status}</Badge></div><p className="text-muted-foreground mt-2 break-all">{step.detail ?? 'Awaiting execution'}</p></div>)}</div>
      </Panel>)}
    </div>}
  </div>;
}

// Audit rows arrive as raw UTC timestamps with microsecond precision. The
// operator clock everywhere else in the app is Eastern, so render these in
// Eastern too and keep the raw value in the title attribute for audit.
function easternTimestamp(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${parsed.toLocaleString('en-CA', { timeZone: 'America/New_York', hour12: false })} ET`;
}

function AuditTrailPage() {
  const [events, setEvents] = useState<Array<{ auditEventId: string; occurredAt: string; actor: string; action: string; resourceType: string; resourceId: string | null; metadata?: Record<string, unknown> }>>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = async () => { setLoading(true); try { const response = await operationsRequest<{ events: typeof events; total?: number }>('/analyst/audit-events?limit=100'); setEvents(response.events); setTotal(typeof response.total === 'number' ? response.total : null); setError(null); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load audit events.'); } finally { setLoading(false); } };
  useEffect(() => { void load(); }, []);
  // The backend records why an event happened (error text, attempt counts) in
  // metadata. An audit page that hides the reason is not an audit page.
  const eventDetail = (metadata?: Record<string, unknown>) => {
    if (!metadata) return null;
    const parts: string[] = [];
    if (typeof metadata.error === 'string' && metadata.error) parts.push(metadata.error);
    if (typeof metadata.attempts === 'number') parts.push(`attempt ${metadata.attempts}${typeof metadata.maxAttempts === 'number' ? `/${metadata.maxAttempts}` : ''}`);
    return parts.length ? parts.join(' · ') : null;
  };
  return <div className="page-content rise-in" data-testid="page-audit-trail"><div className="page-intro"><div><Kicker>Append-only operator record</Kicker><h1>Audit <span className="slash">//</span> trail</h1><p>Operational runs, settlements, corrections, and review actions retain actor and timestamp context.{total !== null && ` Showing the ${Math.min(events.length, total)} most recent of ${total} recorded event(s).`}</p></div><button className="button button-dark" onClick={() => void load()} disabled={loading}><RefreshCw size={15} /> Refresh</button></div>{loading ? <LoadingPanel rows={5} /> : error ? <QueryMessage kind="error" onRetry={() => void load()} /> : events.length === 0 ? <QueryMessage kind="empty" /> : <Panel><div className="table-wrap"><table className="data-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th></tr></thead><tbody>{events.map((event) => { const detail = eventDetail(event.metadata); return <tr key={event.auditEventId}><td className="text-xs whitespace-nowrap" title={event.occurredAt}>{easternTimestamp(event.occurredAt)}</td><td>{event.actor}</td><td><Badge tone="accent">{event.action}</Badge>{detail && <div className="text-xs text-muted-foreground mt-1 break-all">{detail}</div>}</td><td className="font-mono text-xs break-all">{event.resourceType}{event.resourceId ? ` / ${event.resourceId}` : ''}</td></tr>; })}</tbody></table></div></Panel>}</div>;
}

function HealthSource({ source }: { source: SourceBadge }) {
  const tone = toneFor(source.status);
  return <div className="health-source" data-testid={`health-source-${source.name.replaceAll(' ', '-').toLowerCase()}`}><div className="health-source-head"><div className="source-title"><StatusDot tone={tone} /><strong>{source.name}</strong></div><Badge tone={tone}>{source.freshness}</Badge></div><div className="health-bar"><span className={`health-bar-fill fill-${tone}`} style={{ width: tone === 'good' ? '92%' : tone === 'warn' ? '64%' : '28%' }} /></div><div className="health-source-foot"><span>{source.detail}<br /><small>effective {source.effectiveDate ?? 'not reported'} · {source.ageMinutes === null ? 'age unavailable' : `${source.ageMinutes} minutes old`} · {source.isCurrentDate ? 'current date' : 'not current date'}</small></span><code>{source.rowCount.toLocaleString()} rows</code></div></div>;
}

function IssueRow({ issue }: { issue: HealthIssue }) {
  const tone = toneFor(issue.severity);
  return <div className={`issue-row issue-${tone}`} data-testid={`issue-${issue.label.replaceAll(' ', '-').toLowerCase()}`}><div className="issue-icon">{tone === 'bad' ? <X size={15} /> : <AlertTriangle size={15} />}</div><div className="flex-1"><div className="issue-head"><strong>{issue.label}</strong><Badge tone={tone}>{issue.severity}</Badge></div><p>{issue.detail}</p></div><ChevronRight size={15} className="text-muted" /></div>;
}

function SettingsPage() {
  const query = useGetAnalystSettings();
  const data = query.data as AnalystSettings | undefined;
  return (
    <div className="page-content page-settings rise-in">
      <div className="page-intro">
        <div><Kicker>Control plane / safe metadata</Kicker><h1>Settings <span className="slash">//</span> preferences</h1><p>Connection state is readable here. Secrets and write actions are intentionally out of scope for Phase 1.</p></div>
        <div className="safe-readonly"><LockKeyhole size={14} /> Read-only controls</div>
      </div>
      {query.isLoading ? <LoadingPanel rows={5} /> : query.isError ? <QueryMessage kind="error" onRetry={() => query.refetch()} /> : !data ? <QueryMessage kind="empty" /> : (
        <div className="settings-layout">
          <Panel><SectionHeading eyebrow="Connections" title="Source access" detail="No credentials are rendered in the analyst surface." /><div className="connection-list">{data.connections?.length ? data.connections.map((connection) => <div className="connection-row" key={connection.name} data-testid={`connection-${connection.name.replaceAll(' ', '-').toLowerCase()}`}><div className={`connection-icon ${connection.configured ? 'connection-on' : ''}`}>{connection.configured ? <Check size={16} /> : <LockKeyhole size={16} />}</div><div className="flex-1"><div className="connection-head"><strong>{connection.name}</strong><Badge tone={connection.configured ? 'good' : 'warn'}>{connection.configured ? 'Configured' : 'Not configured'}</Badge></div><p>{connection.detail}</p></div><span className="connection-chevron"><ChevronRight size={15} /></span></div>) : <QueryMessage kind="empty" />}</div><div className="settings-note"><ShieldCheck size={16} /><span>Tokens, keys, and secrets remain server-side. This panel only reports safe connection metadata.</span></div></Panel>
          <Panel className="preference-panel"><SectionHeading eyebrow="Analyst defaults" title="Working preferences" detail="Defaults are visible but not editable in this release." /><div className="preference-form"><label htmlFor="timezone">Timezone<span>Used for slate timestamps</span></label><div className="select-wrap"><select id="timezone" value={data.timezone} disabled data-testid="select-timezone"><option value={data.timezone}>{data.timezone}</option></select><ChevronRight size={15} /></div><label htmlFor="market">Default market<span>Projection display context</span></label><div className="select-wrap"><select id="market" value={data.defaultMarket} disabled data-testid="select-default-market"><option value={data.defaultMarket}>{data.defaultMarket}</option></select><ChevronRight size={15} /></div><label htmlFor="cadence">Refresh cadence<span>How often the workspace checks</span></label><div className="select-wrap"><select id="cadence" value={data.refreshCadence} disabled data-testid="select-refresh-cadence"><option value={data.refreshCadence}>{data.refreshCadence}</option></select><ChevronRight size={15} /></div><div className="settings-note"><LockKeyhole size={16} /><span>Preference changes are not configured. This panel is intentionally read-only.</span></div></div></Panel>
        </div>
      )}
    </div>
  );
}

function FuturePage({ label }: { label: string }) {
  return <div className="future-page rise-in"><div className="future-mark-large">F2</div><Kicker>Future phase destination</Kicker><h1>{label}</h1><p>This room is mapped in the navigation, but its data contract has not shipped in Phase 1. Nothing is simulated here.</p><Link href="/" className="button button-dark" data-testid="link-return-to-today"><Home size={15} /> Return to Today</Link><div className="future-foot"><GitBranch size={15} /> Available when its source contract is defined <span>—</span> no invented data</div></div>;
}


function LabSearchPanel({ searchInput, setSearchInput, onSearch, onDirectId, results, onSelect, selectedId, hasSearch, isLoading, truncated, resultLimit, placeholder = "Search entities..." }: { searchInput: string, setSearchInput: (s: string) => void, onSearch: (e: React.FormEvent) => void, onDirectId: (value: string) => void, results?: ResearchSearchResult[], onSelect: (id: number) => void, selectedId?: number, hasSearch: boolean, isLoading: boolean, truncated?: boolean, resultLimit?: number, placeholder?: string }) {
  const [directId, setDirectId] = useState('');
  return (
    <Panel className="lab-sidebar">
      <SectionHeading eyebrow="Entity resolution" title="Directory" />
      <div className="px-[21px] pb-[21px]">
        <form onSubmit={onSearch} className="search-box">
          <input type="search" className="search-input" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder={placeholder} data-testid="input-lab-search" />
          <button type="submit" className="button button-dark" data-testid="button-lab-search"><Search size={14} /></button>
        </form>
        <form onSubmit={(event) => { event.preventDefault(); onDirectId(directId); }} className="search-box mt-2">
          <input type="text" inputMode="numeric" className="search-input" value={directId} onChange={(e) => setDirectId(e.target.value)} placeholder="Historical profile ID" aria-label="Historical canonical player ID" data-testid="input-lab-historical-id" />
          <button type="submit" className="button button-quiet" data-testid="button-lab-historical-id">Open</button>
        </form>
        <p className="mt-2 text-muted-foreground text-[10px] font-mono">Optional canonical ID opens retained historical evidence. It does not add a player to today&apos;s slate.</p>
        {results && results.length > 0 && (
          <div className="search-results">
            {results.map((r) => (
              <button key={r.playerId} onClick={() => onSelect(r.playerId)} className={`search-result-btn ${selectedId === r.playerId ? 'bg-muted border-primary' : ''}`} data-testid={`button-select-${r.playerId}`}>
                <strong>{r.name}</strong>
                <span>{r.team} · {r.position} · {r.role}</span>
              </button>
            ))}
          </div>
        )}
        {isLoading && hasSearch && <p className="text-muted-foreground text-xs font-mono">Searching official eligibility…</p>}
        {!isLoading && hasSearch && results && results.length === 0 && (
          <p className="text-muted-foreground text-xs font-mono">No eligible records matched this name and date.</p>
        )}
        {!hasSearch && <p className="text-muted-foreground text-xs font-mono">Search a name, then choose an eligible player.</p>}
        {truncated && <p className="mt-3 text-xs font-mono text-amber-700">Showing the first {resultLimit} matches. Refine the name to narrow the directory.</p>}
      </div>
    </Panel>
  );
}

function MetricCard({ metric }: { metric: ResearchMetric }) {
  const tone = metric.status === 'AVAILABLE' ? 'good' : metric.status === 'QUARANTINED' ? 'bad' : 'warn';
  
  return (
    <div className={`metric-card metric-status-${metric.status.toLowerCase()}`} data-testid={`metric-card-${metric.key}`}>
      <div className="metric-card-head">
        <span className="metric-card-label">{metric.label}</span>
        <Badge tone={tone}>{metric.status.replace('_', ' ')}</Badge>
      </div>
      <div className="metric-card-value">
        {metric.status === 'AVAILABLE' ? (
          <>
            <strong>{metric.value !== null && metric.value !== undefined ? metric.value.toLocaleString(undefined, { maximumFractionDigits: 3 }) : '—'}</strong>
            <span className="metric-unit">{metric.unit}</span>
          </>
        ) : (
          <strong className="metric-empty">—</strong>
        )}
      </div>
      <div className="metric-card-foot">
        <span className="metric-source"><Server size={11} /> {metric.source}</span>
        {metric.sampleSize ? <span>n={metric.sampleSize}</span> : <span />}
      </div>
    </div>
  );
}

function IntelligenceBrief({ coverage }: {
  coverage?: HistoricalIntelligenceCoverage;
}) {
  const tone = toneFor(coverage?.status);
  return (
    <div className="intelligence-brief" data-testid="historical-intelligence-brief">
      <div>
        <Kicker>Permanent player intelligence</Kicker>
        <strong>Retained historical evidence</strong>
        <p>
          {coverage?.status === 'READY'
            ? `${coverage.eventCount.toLocaleString()} source event(s), ${coverage.contextCount.toLocaleString()} shared game context record(s), and ${coverage.derivedFeatureCount.toLocaleString()} derived feature(s).`
            : coverage?.status === 'PARTIAL'
              ? 'Source events exist, but profile coverage is still partial. Thin or missing history remains visible.'
              : 'No retained historical events are available for this player yet. This is not treated as a zero statistic.'}
        </p>
      </div>
      <div className="intelligence-brief-meta">
        <Badge tone={tone}>{coverage?.status ?? 'NOT FOUND'}</Badge>
        {coverage?.firstObservationDate && <span>{coverage.firstObservationDate} to {coverage.latestObservationDate}</span>}
      </div>
      <small>Background-only and bounded. The permanent all-player worker owns source loading; this profile view never alters today&apos;s slate.</small>
    </div>
  );
}
function LabProfile({ profile, window, onWindowChange, windows }: { profile: ResearchProfile, window: string, onWindowChange: (w: string) => void, windows: string[] }) {
  return (
    <Panel className="flex-1 overflow-hidden">
      <div className="profile-header">
        <div className="profile-identity">
          <Kicker>{profile.identity.playerId} / {profile.identity.rosterState}</Kicker>
          <h2>{profile.identity.name}</h2>
          <div className="profile-tags">
            <span className="team-chip">{profile.identity.team}</span>
            <span>{profile.identity.position}</span>
            <span>B: {profile.identity.bats} / T: {profile.identity.throws}</span>
            <Badge tone="neutral">{profile.role}</Badge>
          </div>
        </div>
        <div className="flex flex-col items-end gap-3">
          <div className="window-selector">
            {windows.map(w => (
              <button key={w} onClick={() => onWindowChange(w)} className={`window-btn ${window === w ? 'window-btn-active' : ''}`} data-testid={`button-window-${w.toLowerCase()}`}>{w.replace(/_/g, ' ')}</button>
            ))}
          </div>
          <div className="text-right font-mono text-[9px] text-muted-foreground uppercase tracking-wider">
            Effective: {profile.effectiveFrom.slice(0, 10)} to {profile.effectiveTo.slice(0, 10)}
            <br />
            Freshness: {profile.freshness}
          </div>
        </div>
      </div>
      
      <div className="metric-panels">
        {profile.panels.map(panel => (
          <div key={panel.title} className="metric-panel" data-testid={`panel-${panel.title.replace(/\s+/g, '-').toLowerCase()}`}>
            <h3>{panel.title}</h3>
            <div className="metric-grid-cards">
              {panel.metrics.map((m, index) => <MetricCard key={`${m.key}-${m.source}-${index}`} metric={m} />)}
            </div>
          </div>
        ))}
        {profile.arsenal.length > 0 && (
          <div className="metric-panel" data-testid="panel-arsenal">
            <h3>Observed Arsenal</h3>
            <div className="metric-grid-cards">
              {profile.arsenal.map((m, index) => <MetricCard key={`${m.key}-${m.source}-${index}`} metric={m} />)}
            </div>
          </div>
        )}
      </div>

      {profile.notes.length > 0 && (
        <div className="border-t border-border p-6 bg-accent/5">
          <Kicker>Analyst Notes</Kicker>
          <ul className="mt-4 space-y-2">
            {profile.notes.map((note, i) => (
              <li key={i} className="text-xs text-foreground flex gap-2"><ArrowRight size={12} className="mt-0.5 text-accent" /> {note}</li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

const LAB_WINDOWS = ['SEASON', 'CAREER', 'ROLLING_7', 'ROLLING_14', 'ROLLING_30', 'ROLLING_60'] as const;
type LabWindow = typeof LAB_WINDOWS[number];

function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function useLabUrlState() {
  const [location, setLocation] = useLocation();
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const rawPlayerId = params.get('playerId');
  const rawSearch = params.get('search');
  const rawDate = params.get('date');
  const rawWindow = params.get('window');
  const playerId = rawPlayerId && /^\d+$/.test(rawPlayerId) && Number(rawPlayerId) > 0 ? Number(rawPlayerId) : undefined;
  const windowParam: LabWindow = rawWindow && LAB_WINDOWS.includes(rawWindow as LabWindow) ? rawWindow as LabWindow : 'SEASON';
  const invalidParameter = rawPlayerId && !playerId
    ? 'Player ID must be a positive whole number.'
    : rawDate && !isCalendarDate(rawDate)
      ? 'Date must be a real calendar date in YYYY-MM-DD format.'
      : rawWindow && !LAB_WINDOWS.includes(rawWindow as LabWindow)
        ? 'Window must be one of the supported research windows.'
        : rawSearch && (rawSearch.trim().length > 120 || ['null', 'undefined'].includes(rawSearch.trim().toLowerCase()))
          ? 'Search text is invalid. Remove null-like values and keep it under 120 characters.'
          : null;
  const search = rawSearch?.trim() || undefined;
  const dateParam = rawDate || undefined;

  const [searchInput, setSearchInput] = useState(search || '');
  useEffect(() => setSearchInput(search || ''), [search]);

  const updateUrl = (update: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(searchString);
    update(next);
    const query = next.toString();
    setLocation(query ? `${location}?${query}` : location);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    updateUrl((next) => {
      const value = searchInput.trim();
      if (value) next.set('search', value);
      else next.delete('search');
      next.delete('playerId');
    });
  };

  const handleSelect = (id: number) => {
    updateUrl((next) => {
      next.set('playerId', id.toString());
      next.delete('search');
    });
  };
  const handleDirectId = (value: string) => {
    updateUrl((next) => {
      const id = value.trim();
      if (id) next.set('playerId', id);
      else next.delete('playerId');
      next.delete('search');
    });
  };

  const handleWindowChange = (w: string) => {
    updateUrl((next) => next.set('window', w));
  };
  const handleDateChange = (date: string) => {
    updateUrl((next) => {
      if (date) next.set('date', date);
      else next.delete('date');
    });
  };
  return { playerId, search, windowParam, dateParam, searchInput, setSearchInput, invalidParameter, queryEnabled: !invalidParameter, handleSearch, handleDirectId, handleSelect, handleWindowChange, handleDateChange };
}

function LabStateNotice({ title, detail, status, notices = [], tone = 'neutral', retry }: { title: string; detail: string; status?: string; notices?: string[]; tone?: Tone; retry?: () => void }) {
  return (
    <Panel className="h-full min-h-[400px] flex items-center justify-center border-dashed">
      <div className="query-message max-w-xl" data-testid="lab-state">
        <div className="query-icon"><StatusDot tone={tone} /></div>
        <div>
          <strong>{title}</strong>
          <p>{detail}</p>
          {status && <div className="mt-3"><Badge tone={tone}>{status}</Badge></div>}
          {notices.length > 0 && <ul className="mt-3 space-y-1 text-xs text-muted-foreground">{notices.map((notice) => <li key={notice}>• {notice}</li>)}</ul>}
        </div>
        {retry && <button className="button button-quiet ml-auto" onClick={retry}><RefreshCw size={14} /> Retry</button>}
      </div>
    </Panel>
  );
}

function labErrorDetail(error: unknown) {
  if (error && typeof error === 'object' && 'data' in error) {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === 'object' && 'error' in data) return String((data as { error: unknown }).error);
  }
  return 'The research service could not complete this request. Retry it, then inspect Data Health if the issue persists.';
}

function PlayerLabPage() {
  const state = useLabUrlState();
  const labParams = { playerId: state.playerId, search: state.search, window: state.windowParam, date: state.dateParam };
  const query = useGetAnalystPlayerLab(
    labParams,
    { query: { enabled: state.queryEnabled, queryKey: getGetAnalystPlayerLabQueryKey(labParams) } },
  );
  const data = query.data;
  const historical = useGetHistoricalIntelligenceCoverage(
    { playerId: state.playerId ?? undefined },
    { query: { enabled: Boolean(state.playerId), queryKey: getGetHistoricalIntelligenceCoverageQueryKey({ playerId: state.playerId ?? undefined }) } },
  );
  const refresh = useRefreshAnalystResearch({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetAnalystPlayerLabQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetAnalystPitcherLabQueryKey() });
      },
    },
  });

  return (
    <div className="page-content rise-in">
      <div className="page-intro">
        <div>
          <Kicker>Hitter inspection</Kicker>
          <h1>Player <span className="slash">//</span> lab</h1>
          <p>Canonical hitter research profiles. Provenance-backed evidence, zero synthetic predictions.</p>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" className="search-input !h-[35px] !w-auto" value={state.dateParam || data?.profile?.effectiveTo.slice(0, 10) || ''} onChange={(e) => state.handleDateChange(e.target.value)} data-testid="input-player-lab-date" />
          <button className="button button-dark" onClick={() => refresh.mutate({ params: state.dateParam ? { date: state.dateParam } : undefined })} disabled={refresh.isPending} data-testid="button-refresh-research">
            <RefreshCw size={15} /> {refresh.isPending ? 'Ingesting...' : 'Sync statcast/fangraphs'}
          </button>
        </div>
      </div>

      <div className="lab-layout">
        <LabSearchPanel 
          searchInput={state.searchInput}
          setSearchInput={state.setSearchInput}
          onSearch={state.handleSearch}
          onDirectId={state.handleDirectId}
          results={data?.searchResults} 
          onSelect={state.handleSelect}
          selectedId={state.playerId}
          hasSearch={Boolean(state.search)}
          isLoading={query.isLoading}
          truncated={data?.searchResultsTruncated}
          resultLimit={data?.searchResultLimit}
          placeholder="Search hitters..."
        />
        
        {state.invalidParameter ? (
          <div className="flex-1"><LabStateNotice title="Invalid direct link" detail={state.invalidParameter} status="REQUEST NOT SENT" tone="bad" /></div>
        ) : query.isLoading ? (
          <div className="flex-1"><LoadingPanel rows={10} /></div>
        ) : query.isError ? (
          <div className="flex-1"><LabStateNotice title="Research request unavailable" detail={labErrorDetail(query.error)} status="SERVICE OR REQUEST ERROR" tone="bad" retry={() => query.refetch()} /></div>
        ) : data?.profile ? (
          <div className="flex-1 space-y-4"><LabProfile
            profile={data.profile} 
            window={state.windowParam}
            onWindowChange={state.handleWindowChange}
            windows={[...LAB_WINDOWS]}
          /><IntelligenceBrief coverage={historical.data} /><LabStateNotice title="Source and eligibility context" detail="This profile shows only source-backed evidence available for the requested as-of date and research window." status={data.sourceStatus} notices={data.notices} tone={toneFor(data.sourceStatus)} /></div>
        ) : (
          <div className="flex-1">
            <LabStateNotice title={data?.sourceStatus === 'SEARCH REQUIRED' ? 'Start with a player name' : 'No profile is available'} detail={data?.notices[0] ?? 'Use the directory to search a player.'} status={data?.sourceStatus} notices={data?.notices.slice(1)} tone={toneFor(data?.sourceStatus)} />
          </div>
        )}
      </div>
    </div>
  );
}

function PitcherLabPage() {
  const state = useLabUrlState();
  const labParams = { playerId: state.playerId, search: state.search, window: state.windowParam, date: state.dateParam };
  const query = useGetAnalystPitcherLab(
    labParams,
    { query: { enabled: state.queryEnabled, queryKey: getGetAnalystPitcherLabQueryKey(labParams) } },
  );
  const data = query.data;
  const historical = useGetHistoricalIntelligenceCoverage(
    { playerId: state.playerId ?? undefined },
    { query: { enabled: Boolean(state.playerId), queryKey: getGetHistoricalIntelligenceCoverageQueryKey({ playerId: state.playerId ?? undefined }) } },
  );
  const refresh = useRefreshAnalystResearch({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetAnalystPlayerLabQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetAnalystPitcherLabQueryKey() });
      },
    },
  });

  return (
    <div className="page-content rise-in">
      <div className="page-intro">
        <div>
          <Kicker>Pitcher inspection</Kicker>
          <h1>Pitcher <span className="slash">//</span> lab</h1>
          <p>Canonical pitcher research profiles. Provenance-backed evidence, zero synthetic predictions.</p>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" className="search-input !h-[35px] !w-auto" value={state.dateParam || data?.profile?.effectiveTo.slice(0, 10) || ''} onChange={(e) => state.handleDateChange(e.target.value)} data-testid="input-pitcher-lab-date" />
          <button className="button button-dark" onClick={() => refresh.mutate({ params: state.dateParam ? { date: state.dateParam } : undefined })} disabled={refresh.isPending} data-testid="button-refresh-research">
            <RefreshCw size={15} /> {refresh.isPending ? 'Ingesting...' : 'Sync statcast/fangraphs'}
          </button>
        </div>
      </div>

      <div className="lab-layout">
        <LabSearchPanel 
          searchInput={state.searchInput}
          setSearchInput={state.setSearchInput}
          onSearch={state.handleSearch}
          onDirectId={state.handleDirectId}
          results={data?.searchResults} 
          onSelect={state.handleSelect}
          selectedId={state.playerId}
          hasSearch={Boolean(state.search)}
          isLoading={query.isLoading}
          truncated={data?.searchResultsTruncated}
          resultLimit={data?.searchResultLimit}
          placeholder="Search pitchers..."
        />
        
        {state.invalidParameter ? (
          <div className="flex-1"><LabStateNotice title="Invalid direct link" detail={state.invalidParameter} status="REQUEST NOT SENT" tone="bad" /></div>
        ) : query.isLoading ? (
          <div className="flex-1"><LoadingPanel rows={10} /></div>
        ) : query.isError ? (
          <div className="flex-1"><LabStateNotice title="Research request unavailable" detail={labErrorDetail(query.error)} status="SERVICE OR REQUEST ERROR" tone="bad" retry={() => query.refetch()} /></div>
        ) : data?.profile ? (
          <div className="flex-1 space-y-4"><LabProfile
            profile={data.profile} 
            window={state.windowParam}
            onWindowChange={state.handleWindowChange}
            windows={[...LAB_WINDOWS]}
          /><IntelligenceBrief coverage={historical.data} /><LabStateNotice title="Source and eligibility context" detail="This profile shows only source-backed evidence available for the requested as-of date and research window." status={data.sourceStatus} notices={data.notices} tone={toneFor(data.sourceStatus)} /></div>
        ) : (
          <div className="flex-1">
            <LabStateNotice title={data?.sourceStatus === 'SEARCH REQUIRED' ? 'Start with a pitcher name' : 'No profile is available'} detail={data?.notices[0] ?? 'Use the directory to search a pitcher.'} status={data?.sourceStatus} notices={data?.notices.slice(1)} tone={toneFor(data?.sourceStatus)} />
          </div>
        )}
      </div>
    </div>
  );
}

function GameLabPage() {
  const [location, setLocation] = useLocation();
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const dateParam = params.get('date') || undefined;
  const gameIdParam = params.get('gameId') || undefined;

  const query = useGetAnalystGameLab({ date: dateParam, gameId: gameIdParam });
  const data = query.data;

  const handleSelect = (id: string) => {
    const newParams = new URLSearchParams(searchString);
    newParams.set('gameId', id);
    setLocation(`${location}?${newParams.toString()}`);
  };

  const handleDateChange = (d: string) => {
    const newParams = new URLSearchParams(searchString);
    newParams.set('date', d);
    newParams.delete('gameId');
    setLocation(`${location}?${newParams.toString()}`);
  };

  return (
    <div className="page-content rise-in">
      <div className="page-intro">
        <div>
          <Kicker>Slate & Park Context</Kicker>
          <h1>Game <span className="slash">//</span> lab</h1>
          <p>Environmental and slate context without matching-level predictions.</p>
        </div>
        <div className="flex items-center gap-2">
           <input type="date" className="search-input !h-[35px] !w-auto" value={dateParam || data?.date || ''} onChange={(e) => handleDateChange(e.target.value)} data-testid="input-game-date" />
           <button className="icon-button" onClick={() => query.refetch()} data-testid="button-refresh-games"><RefreshCw size={14} /></button>
        </div>
      </div>

      <div className="lab-layout">
        <Panel className="lab-sidebar">
          <SectionHeading eyebrow="Slate" title="Games" detail={data?.date} />
          <div className="px-[21px] pb-[21px]">
            {query.isLoading ? (
               <LoadingPanel rows={5} />
            ) : data?.games?.length ? (
               <div className="game-list-lab">
                 {data.games.map(g => (
                   <button key={g.id} onClick={() => handleSelect(g.id)} className={`game-btn ${gameIdParam === g.id ? 'game-btn-active' : ''}`} data-testid={`button-select-game-${g.id}`}>
                     <span className="game-btn-teams">{g.away} @ {g.home}</span>
                     <span className="game-btn-meta">{g.time} · {g.park}</span>
                   </button>
                 ))}
               </div>
            ) : (
               <p className="text-muted-foreground text-xs font-mono">No games found.</p>
            )}
          </div>
        </Panel>

        <div className="flex-1 flex flex-col gap-6">
          {query.isLoading ? (
            <LoadingPanel rows={8} />
          ) : !data?.selectedGame ? (
            <Panel className="h-full min-h-[400px] flex items-center justify-center border-dashed">
              <QueryMessage kind="empty" />
            </Panel>
          ) : (
            <>
              <Panel>
                <div className="p-6 border-b border-border bg-background/50">
                  <Kicker>Game Context / {data.selectedGame.id}</Kicker>
                  <div className="flex items-center gap-6 mt-4">
                    <div className="flex flex-col gap-1">
                      <span className="font-mono text-[10px] text-muted-foreground uppercase">Away</span>
                      <strong className="font-serif text-2xl">{data.selectedGame.away}</strong>
                      <span className="font-mono text-xs">{data.selectedGame.awayStarter.name} ({data.selectedGame.awayStarter.hand})</span>
                    </div>
                    <div className="font-serif text-xl text-muted-foreground">@</div>
                    <div className="flex flex-col gap-1 text-right">
                      <span className="font-mono text-[10px] text-muted-foreground uppercase">Home</span>
                      <strong className="font-serif text-2xl">{data.selectedGame.home}</strong>
                      <span className="font-mono text-xs">{data.selectedGame.homeStarter.name} ({data.selectedGame.homeStarter.hand})</span>
                    </div>
                  </div>
                </div>
                <div className="p-6 grid grid-cols-3 gap-6 border-b border-border bg-card/40">
                   <div>
                     <Kicker>Time</Kicker>
                     <p className="mt-2 text-sm">{data.selectedGame.time}</p>
                   </div>
                   <div>
                     <Kicker>Venue</Kicker>
                     <p className="mt-2 text-sm">{data.selectedGame.park} ({data.selectedGame.roof})</p>
                   </div>
                   <div>
                     <Kicker>Weather</Kicker>
                     <p className="mt-2 text-sm">{data.selectedGame.weather}</p>
                   </div>
                </div>
              </Panel>

              {data.parkResearch && (
                <Panel>
                  <SectionHeading eyebrow="Venue Context" title="Park Factors" detail={`${data.parkResearch.venue} · Span: ${data.parkResearch.span}`} />
                  <div className="metric-panels pt-0">
                    <div className="metric-grid-cards">
                       {data.parkResearch.factors.map(f => <MetricCard key={f.key} metric={f} />)}
                    </div>
                  </div>
                </Panel>
              )}

              {data.notes && data.notes.length > 0 && (
                <Panel className="bg-accent/5 border-accent/20">
                  <SectionHeading eyebrow="Context" title="Analyst Notes" />
                  <div className="px-[21px] pb-[21px]">
                    <ul className="space-y-2">
                      {data.notes.map((note, i) => (
                        <li key={i} className="text-xs text-foreground flex gap-2"><ArrowRight size={12} className="mt-0.5 text-accent" /> {note}</li>
                      ))}
                    </ul>
                  </div>
                </Panel>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Bullpen Room ─────────────────────────────────────────────────────────────

function availabilityTone(state: string): Tone {
  switch (state) {
    case 'AVAILABLE': return 'good';
    case 'LIKELY_AVAILABLE': return 'good';
    case 'DOUBTFUL': return 'warn';
    case 'OUT': return 'bad';
    case 'STALE': return 'warn';
    default: return 'neutral';
  }
}

function roleBadgeClass(role: string): string {
  switch (role) {
    case 'CLOSER': return 'role-closer';
    case 'PRIMARY_SETUP': return 'role-setup';
    case 'SETUP': return 'role-setup';
    case 'LEFTY_SPECIALIST': return 'role-lefty';
    case 'LONG_MAN': return 'role-longman';
    default: return 'role-unknown';
  }
}

function PitchPips({ pitches, label }: { pitches: number | null; label: string }) {
  const count = pitches ?? 0;
  const tone: Tone = count === 0 ? 'good' : count >= 35 ? 'bad' : count >= 20 ? 'warn' : 'neutral';
  return (
    <div className="pitch-pips" title={`${label}: ${count} pitches`}>
      <span className={`pitch-count tone-${tone}`}>{count}</span>
      <span className="pitch-label">{label}</span>
    </div>
  );
}

function ArmDetailPanel({ arm }: { arm: BullpenArm }) {
  const changeTypeLabel: Record<string, string> = {
    PROMOTION: '⬆ Promoted',
    DEMOTION: '⬇ Demoted',
    OPENER: '○ Opener',
    SWING: '↔ Swing',
  };

  return (
    <div className="arm-detail-panel" data-testid={`arm-detail-${arm.playerId}`}>
      <div className="arm-detail-section">
        <div className="arm-detail-label">Role History</div>
        {arm.roleHistory.length === 0 ? (
          <p className="arm-detail-empty">No role changes recorded yet — role is assigned from game-feed appearances.</p>
        ) : (
          <ol className="role-history-list">
            {arm.roleHistory.map((entry) => (
              <li key={entry.changeId} className="role-history-entry">
                <span className="role-history-date">{entry.effectiveDate}</span>
                <span className={`role-history-change-type change-${entry.changeType.toLowerCase()}`}>
                  {changeTypeLabel[entry.changeType] ?? entry.changeType}
                </span>
                <span className="role-history-transition">
                  {entry.previousRole ? (
                    <>{entry.previousRole.replace(/_/g, ' ')} → <strong>{entry.newRole.replace(/_/g, ' ')}</strong></>
                  ) : (
                    <><em>Initial</em> → <strong>{entry.newRole.replace(/_/g, ' ')}</strong></>
                  )}
                </span>
                <span className="role-history-source">{entry.source}</span>
                {entry.notes && <span className="role-history-notes">{entry.notes}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="arm-detail-section arm-detail-stats">
        <div className="arm-detail-label">Usage Summary</div>
        <div className="arm-detail-stat-row">
          <span>Consecutive days used</span><strong>{arm.consecutiveDays}</strong>
        </div>
        <div className="arm-detail-stat-row">
          <span>Days since last use</span>
          <strong>{arm.daysSinceLastUse !== null ? arm.daysSinceLastUse : '—'}</strong>
        </div>
        {arm.managerOverride && (
          <div className="arm-detail-stat-row">
            <span>Manager override</span>
            <strong>{arm.managerOverride}</strong>
            {arm.managerOverrideNote && <em>{arm.managerOverrideNote}</em>}
          </div>
        )}
        {arm.computedAt && (
          <div className="arm-detail-stat-row muted">
            <span>Computed</span>
            <span>{new Date(arm.computedAt).toLocaleString()}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function ArmRow({ arm }: { arm: BullpenArm }) {
  const [showDetail, setShowDetail] = React.useState(false);
  const tone = availabilityTone(arm.availability);
  return (
    <div className={`arm-row ${arm.staleBadge ? 'arm-stale' : ''} ${showDetail ? 'arm-expanded' : ''}`} data-testid={`arm-row-${arm.playerId}`}>
      <button
        className="arm-row-main"
        onClick={() => setShowDetail((v) => !v)}
        aria-expanded={showDetail}
        title="Click to view role history and usage detail"
      >
        <div className="arm-identity">
          <div className="arm-name-row">
            <strong className="arm-name">{arm.name}</strong>
            <span className="arm-hand">{arm.throws}</span>
            {arm.staleBadge && <span className="stale-badge" title="Freshness window exceeded">STALE</span>}
            {arm.roleHistory.length > 0 && (
              <span className="role-history-badge" title={`${arm.roleHistory.length} role change${arm.roleHistory.length !== 1 ? 's' : ''}`}>
                {arm.roleHistory.length}
              </span>
            )}
          </div>
          <span className={`arm-role ${roleBadgeClass(arm.role)}`}>{arm.role.replace(/_/g, ' ')}</span>
        </div>
        <div className="arm-usage">
          <PitchPips pitches={arm.d1Pitches} label="D-1" />
          <PitchPips pitches={arm.d2Pitches} label="D-2" />
          <PitchPips pitches={arm.d3Pitches} label="D-3" />
        </div>
        <div className="arm-state">
          <Badge tone={tone}>{arm.availability.replace(/_/g, ' ')}</Badge>
          <span className="arm-confidence">
            {arm.managerOverride
              ? <span className="override-label" title={arm.managerOverrideNote ?? undefined}>MGR ✓</span>
              : <span className="heuristic-label">HEURISTIC</span>
            }
          </span>
        </div>
        {arm.multiInningYesterday && (
          <div className="arm-flag" data-testid={`arm-multiinning-${arm.playerId}`}>
            <span>Multi-inning D-1</span>
          </div>
        )}
        <ChevronRight size={12} className={`arm-chevron ${showDetail ? 'rotated' : ''}`} />
      </button>
      {showDetail && <ArmDetailPanel arm={arm} />}
    </div>
  );
}

function UsageGrid({ usage, date }: { usage: BullpenTeam['usage']; date: string }) {
  const d1 = new Date(`${date}T12:00:00Z`);
  const d1Label = `D-1 (${d1.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })})`;
  const d2 = new Date(d1); d2.setUTCDate(d2.getUTCDate() - 1);
  const d2Label = `D-2 (${d2.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })})`;
  const d3 = new Date(d1); d3.setUTCDate(d3.getUTCDate() - 2);
  const d3Label = `D-3 (${d3.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })})`;

  const renderDay = (entries: typeof usage.d1, label: string) => (
    <div className="usage-day">
      <Kicker>{label}</Kicker>
      {entries.length === 0
        ? <p className="muted-copy text-xs">No appearances</p>
        : entries.map((e) => (
          <div key={e.playerId} className="usage-entry" data-testid={`usage-${e.playerId}`}>
            <span className="usage-name">{e.name}</span>
            <span className="usage-pitches">{e.pitches}p</span>
            <span className="usage-ip">{e.ip} IP</span>
            {e.multiInning && <span className="multi-badge">MI</span>}
          </div>
        ))
      }
    </div>
  );

  return (
    <div className="usage-grid">
      {renderDay(usage.d1, d1Label)}
      {renderDay(usage.d2, d2Label)}
      {renderDay(usage.d3, d3Label)}
    </div>
  );
}

function TeamBullpenPanel({ team, date, expanded, onToggle }: {
  team: BullpenTeam;
  date: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const available = team.arms.filter((a) => a.availability === 'AVAILABLE' || a.availability === 'LIKELY_AVAILABLE').length;
  const doubtful = team.arms.filter((a) => a.availability === 'DOUBTFUL').length;
  const out = team.arms.filter((a) => a.availability === 'OUT').length;
  const unknown = team.arms.filter((a) => a.availability === 'UNKNOWN' || a.availability === 'STALE').length;

  return (
    <div className={`team-bullpen-panel ${expanded ? 'expanded' : ''}`} data-testid={`team-panel-${team.abbreviation}`}>
      <button className="team-panel-header" onClick={onToggle} aria-expanded={expanded}>
        <div className="team-header-left">
          <span className="team-abbr">{team.abbreviation}</span>
          <span className="team-name-small">{team.name}</span>
          {team.staleBadge && <span className="stale-badge">STALE</span>}
        </div>
        <div className="team-header-stats">
          <span className="avail-stat avail-good">{available} avail</span>
          {doubtful > 0 && <span className="avail-stat avail-warn">{doubtful} doubtful</span>}
          {out > 0 && <span className="avail-stat avail-bad">{out} out</span>}
          {unknown > 0 && <span className="avail-stat avail-neutral">{unknown} unk</span>}
        </div>
        <ChevronRight size={14} className={`panel-chevron ${expanded ? 'rotated' : ''}`} />
      </button>
      {expanded && (
        <div className="team-panel-body">
          <div className="bullpen-columns">
            <div className="arms-column">
              <Kicker>Availability board</Kicker>
              {team.arms.length === 0
                ? <QueryMessage kind="empty" />
                : team.arms.map((arm) => <ArmRow key={arm.playerId} arm={arm} />)
              }
            </div>
            <div className="leverage-column">
              <Kicker>Leverage sequence</Kicker>
              <div className="leverage-map">
                {team.leverageMap.roleUncertainty && (
                  <div className="leverage-notice">
                    <AlertTriangle size={13} />
                    <span>{team.leverageMap.notes ?? 'Role data unavailable'}</span>
                  </div>
                )}
                {[
                  { label: '9th / Close', id: team.leverageMap.projected9th },
                  { label: '8th / Setup', id: team.leverageMap.projected8th },
                  { label: '7th', id: team.leverageMap.projected7th },
                  { label: 'Lefty specialist', id: team.leverageMap.highestLeverageLefty },
                  { label: 'Long man', id: team.leverageMap.longMan },
                ].map(({ label, id }) => {
                  const arm = id ? team.arms.find((a) => a.playerId === id) : null;
                  return (
                    <div key={label} className="leverage-slot">
                      <span className="leverage-label">{label}</span>
                      {arm
                        ? <span className="leverage-arm"><strong>{arm.name}</strong> <Badge tone={availabilityTone(arm.availability)}>{arm.availability}</Badge></span>
                        : <span className="leverage-empty">—</span>
                      }
                    </div>
                  );
                })}
              </div>
              <div className="usage-section">
                <Kicker>Recent usage</Kicker>
                <UsageGrid usage={team.usage} date={date} />
              </div>
            </div>
          </div>
          <div className="coverage-bar-row">
            <span className="coverage-label">Coverage {Math.round(team.coveragePercentage)}%</span>
            <div className="coverage-bar">
              <span className="coverage-fill" style={{ width: `${team.coveragePercentage}%` }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BullpenRoomPage() {
  const [dateParam, setDateParam] = useState('');
  const [teamFilter, setTeamFilter] = useState('');
  const [expandedTeams, setExpandedTeams] = useState<Set<number>>(new Set());

  const effectiveDate = dateParam || new Date().toISOString().slice(0, 10);
  const params = { date: effectiveDate, ...(teamFilter ? { team: teamFilter } : {}) };

  const query = useGetAnalystBullpenRoom(params);
  const refreshBullpenMutation = useRefreshBullpen({
    mutation: {
      onSuccess: () => query.refetch(),
    },
  });
  const data = query.data as BullpenRoom | undefined;

  const toggleTeam = (teamId: number) => {
    setExpandedTeams((prev) => {
      const next = new Set(prev);
      if (next.has(teamId)) next.delete(teamId);
      else next.add(teamId);
      return next;
    });
  };

  const expandAll = () => setExpandedTeams(new Set(data?.teams.map((t) => t.teamId) ?? []));
  const collapseAll = () => setExpandedTeams(new Set());

  return (
    <div className="page-content rise-in">
      <div className="page-intro">
        <div>
          <Kicker>Relief corps / Phase 2B</Kicker>
          <h1>Bullpen <span className="slash">//</span> room</h1>
          <p>Availability board, D-1/D-2/D-3 usage, leverage sequences, and role history. Heuristic states only — manager overrides win unconditionally.</p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <input
            type="date"
            className="search-input !h-[35px] !w-auto"
            value={dateParam}
            onChange={(e) => setDateParam(e.target.value)}
            data-testid="input-bullpen-date"
          />
          <input
            type="text"
            className="search-input !h-[35px] !w-[80px] uppercase"
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value.toUpperCase())}
            placeholder="Team"
            maxLength={3}
            data-testid="input-bullpen-team"
          />
          <button
            className="button button-dark"
            onClick={() => refreshBullpenMutation.mutate({ params: { date: effectiveDate } })}
            disabled={refreshBullpenMutation.isPending}
            data-testid="button-refresh-bullpen"
          >
            <RefreshCw size={15} />
            {refreshBullpenMutation.isPending ? 'Ingesting…' : 'Refresh bullpen'}
          </button>
        </div>
      </div>

      {data && (
        <div className="metric-grid mb-6">
          <Metric label="Teams with data" value={data.summary.teamsWithData} note="Active bullpen profiles" tone="accent" />
          <Metric label="Arms available" value={data.summary.armsAvailable + data.summary.armsLikelyAvailable} note={`${data.summary.armsAvailable} fully available`} tone={data.summary.armsAvailable > 0 ? 'good' : 'warn'} />
          <Metric label="Doubtful / Out" value={`${data.summary.armsDoubtful} / ${data.summary.armsOut}`} note="Fatigued arms" tone={data.summary.armsOut > 0 ? 'bad' : data.summary.armsDoubtful > 0 ? 'warn' : 'good'} />
          <Metric label="Unknown state" value={data.summary.armsUnknown} note="No appearance data yet" tone={data.summary.armsUnknown > 0 ? 'neutral' : 'good'} />
        </div>
      )}

      {!data?.teams.length && !query.isLoading && (
        <Panel className="mb-4 bg-accent/5 border-accent/20">
          <div className="p-6">
            <Kicker>No data yet</Kicker>
            <p className="mt-2 text-sm">No bullpen data exists for this date. Run a <strong>Refresh bullpen</strong> to ingest the last 3 days of MLB game logs and compute availability states.</p>
          </div>
        </Panel>
      )}

      {query.isLoading ? (
        <LoadingPanel rows={5} />
      ) : query.isError ? (
        <QueryMessage kind="error" onRetry={() => query.refetch()} />
      ) : data && data.teams.length > 0 ? (
        <>
          <div className="flex items-center justify-between mb-4">
            <Kicker>{data.teams.length} team{data.teams.length !== 1 ? 's' : ''} · {data.date}</Kicker>
            <div className="flex gap-2">
              <button className="button button-quiet" onClick={expandAll} data-testid="button-expand-all">Expand all</button>
              <button className="button button-quiet" onClick={collapseAll} data-testid="button-collapse-all">Collapse all</button>
            </div>
          </div>
          <div className="bullpen-team-list" data-testid="bullpen-team-list">
            {data.teams.map((team) => (
              <TeamBullpenPanel
                key={team.teamId}
                team={team}
                date={data.date}
                expanded={expandedTeams.has(team.teamId)}
                onToggle={() => toggleTeam(team.teamId)}
              />
            ))}
          </div>
        </>
      ) : null}

      <Panel className="mt-6 bg-accent/5 border-accent/20">
        <div className="p-6">
          <Kicker>Heuristic rules (Phase 2B)</Kicker>
          <div className="notes-grid mt-4">
            <div><span>01</span><p><strong>OUT</strong> — 3 consecutive days with ≥1 pitch each</p></div>
            <div><span>02</span><p><strong>DOUBTFUL</strong> — 2 consecutive days, OR ≥35 pitches yesterday, OR multi-inning yesterday (≥2.0 IP)</p></div>
            <div><span>03</span><p><strong>LIKELY AVAILABLE</strong> — pitched 2–3 days ago but not yesterday</p></div>
            <div><span>04</span><p><strong>AVAILABLE</strong> — no appearance in last 3 days</p></div>
            <div><span>05</span><p><strong>Manager override</strong> wins unconditionally over any heuristic state</p></div>
            <div><span>06</span><p><strong>Stale badge</strong> appears when the observation is older than 24 hours</p></div>
          </div>
        </div>
      </Panel>
    </div>
  );
}

// ─── Phase 3 – Market Board ──────────────────────────────────────────────────

const MARKET_LABELS: Record<string, string> = {
  TB: '2+ Total Bases',
  XBH: '1+ Extra Base Hit',
  WALK: 'Batter Walk',
  HR: 'Home Run',
  H_R_RBI: 'H+R+RBI',
};

/**
 * What each confidence basis means, in the operator's words. The old
 * MODEL_REJECTED value collapsed a corrupt artifact, a market mismatch, a
 * partial feature vector and a model that simply declined into one label, so
 * the interface could not tell the operator which had happened.
 */
const CONFIDENCE_BASIS_NOTES: Record<string, string> = {
  RESEARCH_ONLY: 'Research evidence only - no model probability exists for this row.',
  MODEL_CONFIRMED: 'The model ran and confirmed this research row.',
  MODEL_DECLINED: 'The model ran and declined this row. The probability shown is the model output.',
  ARTIFACT_INVALID: 'The active model artifact failed verification. No probability was computed.',
  MARKET_MISMATCH: 'The active model is for a different market. No probability was computed.',
  INSUFFICIENT_FEATURES: 'Too little of the model feature set was present to emit a probability.',
};

const RESEARCH_STATE_TONE: Record<string, Tone> = {
  STRONG: 'good',
  POSITIVE: 'good',
  NEUTRAL: 'neutral',
  NEGATIVE: 'warn',
  BLOCKED: 'bad',
};

function TBEnginePanel({
  slateDate,
  onComplete,
}: {
  slateDate: string;
  onComplete: () => void;
}) {
  const mutation = useRefreshMarketResearchTB();
  const result = mutation.data as TBEngineResult | undefined;

  return (
    <Panel className="mb-6 border-accent/30">
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Kicker>Phase 3A – Total Bases engine</Kicker>
            <p className="text-sm text-muted-foreground mt-1">
              Runs ordinal evidence ranking for the 2+ Total Bases market. Writes to the shared
              market_research_candidates table. Idempotent — re-running overwrites prior results.
            </p>
          </div>
          <button
            className="button button-dark shrink-0"
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate(
                { params: { date: slateDate } },
                { onSuccess: () => onComplete() },
              )
            }
            data-testid="button-run-tb-engine"
          >
            <Sparkles size={14} />
            {mutation.isPending ? 'Running…' : 'Run TB engine'}
          </button>
        </div>

        {mutation.isError && (
          <div className="text-xs text-red-500 font-mono mt-2">
            Error: {String(mutation.error)}
          </div>
        )}

        {result && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-border/40">
            <div className="text-center">
              <div className="text-xl font-bold tabular-nums">{result.candidatesWritten}</div>
              <div className="text-xs text-muted-foreground">candidates written</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold tabular-nums text-good">{result.strongCandidates + result.positiveCandidates}</div>
              <div className="text-xs text-muted-foreground">strong + positive</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold tabular-nums text-bad">{result.blockedCandidates}</div>
              <div className="text-xs text-muted-foreground">blocked</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold tabular-nums">{result.processingMs}ms</div>
              <div className="text-xs text-muted-foreground">processing time</div>
            </div>
          </div>
        )}
        {result?.error && (
          <div className="text-xs text-red-500 font-mono mt-1">Engine error: {result.error}</div>
        )}
        {result?.notes && result.notes.length > 0 && (
          <ul className="text-xs text-muted-foreground list-disc list-inside mt-1">
            {result.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function XBHEnginePanel({
  slateDate,
  onComplete,
}: {
  slateDate: string;
  onComplete: () => void;
}) {
  const mutation = useRefreshMarketResearchXBH();
  const result = mutation.data as XBHEngineResult | undefined;

  return (
    <Panel className="mb-6 border-accent/30">
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Kicker>Phase 3B – Extra Base Hit engine</Kicker>
            <p className="text-sm text-muted-foreground mt-1">
              Runs ordinal evidence ranking for the Extra Base Hit market. Singles are excluded from
              all mechanism paths. Idempotent — re-running overwrites prior results.
            </p>
          </div>
          <button
            className="button button-dark shrink-0"
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate(
                { params: { date: slateDate } },
                { onSuccess: () => onComplete() },
              )
            }
            data-testid="button-run-xbh-engine"
          >
            <Sparkles size={14} />
            {mutation.isPending ? 'Running…' : 'Run XBH engine'}
          </button>
        </div>

        {mutation.isError && (
          <div className="text-xs text-red-500 font-mono mt-2">
            Error: {String(mutation.error)}
          </div>
        )}

        {result && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-border/40">
            <div className="text-center">
              <div className="text-xl font-bold tabular-nums">{result.candidatesWritten}</div>
              <div className="text-xs text-muted-foreground">candidates written</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold tabular-nums text-good">{result.strongCandidates + result.positiveCandidates}</div>
              <div className="text-xs text-muted-foreground">strong + positive</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold tabular-nums text-bad">{result.blockedCandidates}</div>
              <div className="text-xs text-muted-foreground">blocked</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold tabular-nums">{result.processingMs}ms</div>
              <div className="text-xs text-muted-foreground">processing time</div>
            </div>
          </div>
        )}
        {result?.error && (
          <div className="text-xs text-red-500 font-mono mt-1">Engine error: {result.error}</div>
        )}
        {result?.notes && result.notes.length > 0 && (
          <ul className="text-xs text-muted-foreground list-disc list-inside mt-1">
            {result.notes.map((note: string, i: number) => <li key={i}>{note}</li>)}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function WALKEnginePanel({
  slateDate,
  onComplete,
}: {
  slateDate: string;
  onComplete: () => void;
}) {
  const mutation = useRefreshMarketResearchWALK();
  const result = mutation.data as WALKEngineResult | undefined;

  return (
    <Panel className="mb-6 border-accent/30">
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Kicker>Phase 3C – Batter Walk engine</Kicker>
            <p className="text-sm text-muted-foreground mt-1">
              Runs ordinal evidence ranking for the Batter Walk market. Driven by plate discipline
              and pitcher command — power metrics are explicitly absent. Idempotent.
            </p>
          </div>
          <button
            className="button button-dark shrink-0"
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate(
                { params: { date: slateDate } },
                { onSuccess: () => onComplete() },
              )
            }
            data-testid="button-run-walk-engine"
          >
            <Sparkles size={14} />
            {mutation.isPending ? 'Running…' : 'Run WALK engine'}
          </button>
        </div>

        {mutation.isError && (
          <div className="text-xs text-red-500 font-mono mt-2">
            Error: {String(mutation.error)}
          </div>
        )}

        {result && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-border/40">
            <div className="text-center">
              <div className="text-xl font-bold tabular-nums">{result.candidatesWritten}</div>
              <div className="text-xs text-muted-foreground">candidates written</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold tabular-nums text-good">{result.strongCandidates + result.positiveCandidates}</div>
              <div className="text-xs text-muted-foreground">strong + positive</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold tabular-nums text-bad">{result.blockedCandidates}</div>
              <div className="text-xs text-muted-foreground">blocked</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold tabular-nums">{result.processingMs}ms</div>
              <div className="text-xs text-muted-foreground">processing time</div>
            </div>
          </div>
        )}
        {result?.error && (
          <div className="text-xs text-red-500 font-mono mt-1">Engine error: {result.error}</div>
        )}
        {result?.notes && result.notes.length > 0 && (
          <ul className="text-xs text-muted-foreground list-disc list-inside mt-1">
            {result.notes.map((note: string, i: number) => <li key={i}>{note}</li>)}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function HREnginePanel({
  slateDate,
  onComplete,
}: {
  slateDate: string;
  onComplete: () => void;
}) {
  const mutation = useRefreshMarketResearchHR();
  const result = mutation.data as HREngineResult | undefined;

  return (
    <Panel className="mb-6 border-accent/30">
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Kicker>Phase 3D – Home Run engine</Kicker>
            <p className="text-sm text-muted-foreground mt-1">
              Runs ordinal evidence ranking for the Home Run market. PARK_ENVIRONMENT is a
              first-class primary mechanism — not context-only. Idempotent.
            </p>
          </div>
          <button
            className="button button-dark shrink-0"
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate(
                { params: { date: slateDate } },
                { onSuccess: () => onComplete() },
              )
            }
            data-testid="button-run-hr-engine"
          >
            <Sparkles size={14} />
            {mutation.isPending ? 'Running…' : 'Run HR engine'}
          </button>
        </div>

        {mutation.isError && (
          <div className="text-xs text-red-500 font-mono mt-2">
            Error: {String(mutation.error)}
          </div>
        )}

        {result && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-border/40">
            <div className="text-center">
              <div className="text-xl font-bold tabular-nums">{result.candidatesWritten}</div>
              <div className="text-xs text-muted-foreground">candidates written</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold tabular-nums text-good">{result.strongCandidates + result.positiveCandidates}</div>
              <div className="text-xs text-muted-foreground">strong + positive</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold tabular-nums text-bad">{result.blockedCandidates}</div>
              <div className="text-xs text-muted-foreground">blocked</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold tabular-nums">{result.processingMs}ms</div>
              <div className="text-xs text-muted-foreground">processing time</div>
            </div>
          </div>
        )}
        {result?.error && (
          <div className="text-xs text-red-500 font-mono mt-1">Engine error: {result.error}</div>
        )}
        {result?.notes && result.notes.length > 0 && (
          <ul className="text-xs text-muted-foreground list-disc list-inside mt-1">
            {result.notes.map((note: string, i: number) => <li key={i}>{note}</li>)}
          </ul>
        )}
      </div>
    </Panel>
  );
}

// ── Phase 4A – Feature Store Panel ───────────────────────────────────────────

function FeatureStoreCapturePanel({ slateDate }: { slateDate: string }) {
  const capture = useCaptureFeatureStoreSlate();
  const result = capture.data as FeatureStoreCaptureResult | undefined;

  return (
    <Panel className="mb-6 border-accent/30">
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Kicker>Phase 4A – Feature store capture</Kicker>
            <p className="text-sm text-muted-foreground mt-1">
              Freeze immutable pregame feature snapshots for all market research candidates on this
              slate date. Idempotent — identical feature hashes are skipped. Run after all four
              market engines complete.
            </p>
          </div>
          <button
            className="button button-dark shrink-0"
            disabled={capture.isPending}
            onClick={() => capture.mutate({ params: { date: slateDate } })}
            data-testid="button-capture-feature-store"
          >
            <Database size={14} />
            {capture.isPending ? 'Capturing…' : 'Capture snapshots'}
          </button>
        </div>
        {capture.isError && (
          <div className="text-xs text-red-500 font-mono mt-2">Error: {String(capture.error)}</div>
        )}
        {result && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-border/40">
            <div className="text-center">
              <div className="text-xl font-bold tabular-nums text-good">{result.snapshotsWritten}</div>
              <div className="text-xs text-muted-foreground">written</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold tabular-nums">{result.snapshotsSkipped}</div>
              <div className="text-xs text-muted-foreground">skipped (identical hash)</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold tabular-nums text-bad">{result.snapshotErrors}</div>
              <div className="text-xs text-muted-foreground">errors</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold tabular-nums">{result.processingMs}ms</div>
              <div className="text-xs text-muted-foreground">processing time</div>
            </div>
          </div>
        )}
        {result?.markets && result.markets.length > 0 && (
          <div className="text-xs text-muted-foreground">
            Markets covered: {result.markets.join(', ')} · {result.candidatesFound} candidates found
          </div>
        )}
        {result?.error && (
          <div className="text-xs text-red-500 font-mono mt-1">Engine error: {result.error}</div>
        )}
        {result?.notes && result.notes.length > 0 && (
          <ul className="text-xs text-muted-foreground list-disc list-inside">
            {result.notes.map((note, i) => <li key={i}>{note}</li>)}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function FeatureStoreBackfillPanel() {
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const backfill = useBackfillFeatureStore();
  const result = backfill.data;

  return (
    <Panel className="mb-6 border-border/40">
      <div className="p-4 space-y-3">
        <div>
          <Kicker>Backfill historical snapshots</Kicker>
          <p className="text-sm text-muted-foreground mt-1">
            Populate pregame feature snapshots from existing market research candidates for a date
            range. Idempotent — already-captured snapshots are skipped.
          </p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <input
            type="date"
            className="search-input !h-[35px] !w-auto"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            placeholder="From date"
          />
          <input
            type="date"
            className="search-input !h-[35px] !w-auto"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            placeholder="To date"
          />
          <button
            className="button button-dark"
            disabled={backfill.isPending || !fromDate || !toDate}
            onClick={() => backfill.mutate({ params: { dateFrom: fromDate, dateTo: toDate } })}
          >
            <RefreshCw size={14} />
            {backfill.isPending ? 'Backfilling…' : 'Run backfill'}
          </button>
        </div>
        {result && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-border/40 text-center">
            <div>
              <div className="text-xl font-bold tabular-nums">{result.datesProcessed}</div>
              <div className="text-xs text-muted-foreground">dates processed</div>
            </div>
            <div>
              <div className="text-xl font-bold tabular-nums">{result.candidatesFound}</div>
              <div className="text-xs text-muted-foreground">candidates found</div>
            </div>
            <div>
              <div className="text-xl font-bold tabular-nums text-good">{result.snapshotsWritten}</div>
              <div className="text-xs text-muted-foreground">written</div>
            </div>
            <div>
              <div className="text-xl font-bold tabular-nums">{result.snapshotsSkipped}</div>
              <div className="text-xs text-muted-foreground">skipped</div>
            </div>
          </div>
        )}
        {result?.error && (
          <div className="text-xs text-red-500 font-mono mt-1">Error: {result.error}</div>
        )}
      </div>
    </Panel>
  );
}

function FeatureStorePage() {
  const [slateDate, setSlateDate] = useState(new Date().toISOString().slice(0, 10));
  const [filterPlayer, setFilterPlayer] = useState('');
  const [filterMarket, setFilterMarket] = useState<SettledMarketShortCode | ''>('');

  const query = useGetAnalystFeatureStore({
    dateFrom: slateDate,
    dateTo: slateDate,
    ...(filterPlayer ? { playerId: Number(filterPlayer) } : {}),
    ...(filterMarket ? { market: filterMarket as SettledMarketShortCode } : {}),
    limit: 200,
  });
  const data = query.data as FeatureStoreResult | undefined;

  return (
    <div className="page-content rise-in">
      <div className="page-intro">
        <div>
          <Kicker>Feature store / Phase 4A</Kicker>
          <h1>Pregame <span className="slash">//</span> feature store</h1>
          <p>
            Immutable pregame feature snapshots frozen at slate-cutoff time. Corrections create new
            rows — originals are never mutated. Append-only historical outcomes for model training.
          </p>
        </div>
        <button
          className="button button-dark"
          onClick={() => query.refetch()}
          disabled={query.isLoading}
        >
          <RefreshCw size={15} /> {query.isLoading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* Date selector */}
      <div className="flex gap-2 items-center flex-wrap mb-6">
        <input
          type="date"
          className="search-input !h-[35px] !w-auto"
          value={slateDate}
          onChange={(e) => setSlateDate(e.target.value)}
        />
        <select
          className="search-input !h-[35px]"
          value={filterMarket}
          onChange={(e) => setFilterMarket(e.target.value as SettledMarketShortCode | '')}
        >
          <option value="">All markets</option>
          {(['TB', 'XBH', 'WALK', 'HR'] as MarketShortCode[]).map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <input
          type="number"
          className="search-input !h-[35px] !w-[140px]"
          value={filterPlayer}
          onChange={(e) => setFilterPlayer(e.target.value.trim())}
          placeholder="Player ID"
        />
      </div>

      {/* Capture and backfill panels */}
      <FeatureStoreCapturePanel slateDate={slateDate} />
      <FeatureStoreBackfillPanel />

      {/* Stats */}
      {data?.stats && (
        <Panel className="mb-6">
          <div className="p-4 space-y-3">
            <Kicker>Store summary</Kicker>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div className="text-center">
                <div className="text-xl font-bold tabular-nums">{data.stats.totalSnapshots}</div>
                <div className="text-xs text-muted-foreground">total snapshots</div>
              </div>
              <div className="text-center">
                <div className="text-xl font-bold tabular-nums">{data.stats.originalSnapshots}</div>
                <div className="text-xs text-muted-foreground">originals</div>
              </div>
              <div className="text-center">
                <div className="text-xl font-bold tabular-nums">{data.stats.correctionSnapshots}</div>
                <div className="text-xs text-muted-foreground">corrections</div>
              </div>
              <div className="text-center">
                <div className="text-xl font-bold tabular-nums">{data.stats.distinctSlateDates}</div>
                <div className="text-xs text-muted-foreground">slate dates</div>
              </div>
              <div className="text-center">
                <div className="text-xl font-bold tabular-nums">{data.stats.totalOutcomes}</div>
                <div className="text-xs text-muted-foreground">historical outcomes</div>
              </div>
            </div>
            {/* Per-market breakdown */}
            <div className="flex gap-4 flex-wrap text-xs text-muted-foreground pt-2 border-t border-border/40">
              {(['TB', 'XBH', 'WALK', 'HR'] as MarketShortCode[]).map((m) => (
                <span key={m}>
                  <strong>{m}</strong> {Number(data.stats.snapshotsByMarket?.[m] ?? 0)} snapshots
                </span>
              ))}
            </div>
          </div>
        </Panel>
      )}

      {/* Immutability contract */}
      <Panel className="mb-6 bg-accent/5 border-accent/20">
        <div className="p-4">
          <Kicker>Immutability contract</Kicker>
          <p className="text-xs font-mono text-muted-foreground mt-1">
            {data?.systemNote ?? 'IMMUTABILITY CONTRACT: pregame_feature_snapshots rows are NEVER updated. Corrections create new rows with correction_of FK. historical_outcomes is append-only. No odds, EV, CLV, or sportsbook data is stored.'}
          </p>
        </div>
      </Panel>

      {/* Correction taxonomy */}
      {data?.correctionTaxonomy && (
        <Panel className="mb-6">
          <div className="p-4">
            <Kicker>Process-error taxonomy</Kicker>
            <div className="flex gap-2 flex-wrap mt-2">
              {data.correctionTaxonomy.map((code) => (
                <span key={code} className="text-xs font-mono px-2 py-1 bg-muted rounded">{code}</span>
              ))}
            </div>
          </div>
        </Panel>
      )}

      {/* Snapshot list */}
      {query.isLoading && <p className="text-sm text-muted-foreground">Loading snapshots…</p>}
      {query.isError && (
        <div className="text-xs text-red-500 font-mono">Error: {String(query.error)}</div>
      )}
      {data && data.snapshots.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No snapshots for {slateDate}
          {filterMarket ? ` / ${filterMarket}` : ''}. Run the capture step above after market
          engines complete.
        </p>
      )}
      {data && data.snapshots.length > 0 && (
        <Panel>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border/40">
                  <th className="p-3 font-medium">Player</th>
                  <th className="p-3 font-medium">Market</th>
                  <th className="p-3 font-medium">Rank</th>
                  <th className="p-3 font-medium">State</th>
                  <th className="p-3 font-medium">Primary mechanism</th>
                  <th className="p-3 font-medium">Frozen at</th>
                  <th className="p-3 font-medium">Correction</th>
                </tr>
              </thead>
              <tbody>
                {data.snapshots.map((snap: PregameFeatureSnapshot) => (
                  <tr
                    key={snap.snapshotId}
                    className={`border-b border-border/20 hover:bg-muted/30 ${snap.isCorrection ? 'opacity-70' : ''}`}
                  >
                    <td className="p-3">
                      <div className="font-medium">{snap.playerName}</div>
                      <div className="text-xs text-muted-foreground">#{snap.playerId}</div>
                    </td>
                    <td className="p-3">
                      <span className="font-mono text-xs px-2 py-1 bg-muted rounded">{snap.market}</span>
                    </td>
                    <td className="p-3 tabular-nums">{snap.researchRank ?? '—'}</td>
                    <td className="p-3">
                      <span className={`text-xs font-mono ${
                        snap.researchState === 'STRONG' || snap.researchState === 'POSITIVE'
                          ? 'text-good'
                          : snap.researchState === 'BLOCKED' || snap.researchState === 'NEGATIVE'
                          ? 'text-bad'
                          : ''
                      }`}>
                        {snap.researchState ?? '—'}
                      </span>
                    </td>
                    <td className="p-3 text-xs text-muted-foreground">{snap.primaryMechanism ?? '—'}</td>
                    <td className="p-3 text-xs text-muted-foreground tabular-nums">
                      {new Date(snap.frozenAt).toLocaleTimeString()}
                    </td>
                    <td className="p-3">
                      {snap.isCorrection && (
                        <span className="text-xs font-mono px-2 py-1 bg-amber-100 text-amber-800 rounded">
                          {snap.correctionReason}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}

function MarketBoardPage() {
  const [dateParam, setDateParam] = useState('');
  const [marketParam, setMarketParam] = useState<MarketShortCode | ''>('');
  const effectiveDate = dateParam || currentEasternDate();
  const params = {
    date: effectiveDate,
    ...(marketParam ? { market: marketParam } : {}),
  };
  const boardQuery = useGetAnalystDailyMarketBoard(params);
  const gameQuery = useGetAnalystDailyBoardGameSummary({ date: effectiveDate });
  const refreshBoard = useRefreshAnalystDailyMarketBoard({
    mutation: {
      onSuccess: () => {
        void boardQuery.refetch();
        void gameQuery.refetch();
      },
    },
  });
  const board = boardQuery.data as DailyMarketBoard | undefined;
  const gameSummary = gameQuery.data as DailyBoardGameSummary | undefined;
  const entries = board?.entries ?? [];
  const refresh = () => refreshBoard.mutate({ params });

  return (
    <div className="page-content rise-in">
      <div className="page-intro">
        <div>
          <Kicker>Daily research evidence / Phase 6</Kicker>
          <h1>Market <span className="slash">//</span> board</h1>
          <p>
            Independent research for 2+ Total Bases, Extra Base Hit, Batter Walk, Home Run, and H+R+RBI.
            FantasyPros ranks are retained as reference context only; they never determine the research order.
          </p>
        </div>
        <button
          className="button button-dark"
          onClick={refresh}
          disabled={refreshBoard.isPending}
          data-testid="button-refresh-market-board"
        >
          <RefreshCw size={15} /> {refreshBoard.isPending ? 'Refreshing…' : 'Refresh board'}
        </button>
      </div>

      <div className="flex gap-2 items-center flex-wrap mb-6">
        <input
          type="date"
          className="search-input !h-[35px] !w-auto"
          value={dateParam}
          onChange={(e) => setDateParam(e.target.value)}
          data-testid="input-market-board-date"
        />
        <select
          className="search-input !h-[35px]"
          value={marketParam}
          onChange={(e) => setMarketParam(e.target.value as MarketShortCode | '')}
          data-testid="select-market-board-market"
        >
          <option value="">All markets</option>
          {(['TB', 'XBH', 'WALK', 'HR', 'H_R_RBI'] as MarketShortCode[]).map((m) => (
            <option key={m} value={m}>{MARKET_LABELS[m]}</option>
          ))}
        </select>
      </div>

      <Panel className="mb-6 bg-accent/5 border-accent/20">
        <div className="p-4 space-y-3">
          <Kicker>Operational presentation policy</Kicker>
          <p className="text-xs font-mono text-muted-foreground" data-testid="confidence-policy">
            This board shows independently ranked research only. FantasyPros values are retained as comparison lineage;
            model prediction, calibrated probability, and confidence are never displayed or used to make a selection.
          </p>
          <div className="flex flex-wrap gap-3 mt-3">
          {(['TB', 'XBH', 'WALK', 'HR', 'H_R_RBI'] as MarketShortCode[]).map((m) => (
              <button
                key={m}
                className={`button button-quiet text-xs ${marketParam === m ? 'button-dark' : ''}`}
                onClick={() => setMarketParam(marketParam === m ? '' : m)}
                data-testid={`market-filter-${m}`}
              >
                {MARKET_LABELS[m]}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground" data-testid="prohibited-fields">
            This board intentionally excludes odds, prices, EV, CLV, implied probability, vig, and recommendation fields.
          </p>
        </div>
      </Panel>

      {board && (
        <>
        <ReadinessStrip health={{ readiness: board.readiness, sources: [] }} />
        <div className="metric-grid mb-6">
          <Metric label="Candidates" value={board.total} note={`${marketParam ? MARKET_LABELS[marketParam] : 'all markets'} · ${effectiveDate}`} tone="accent" />
          <Metric label="Market" value={marketParam ? MARKET_LABELS[marketParam] : 'All 5 markets'} note="Each market is independently ranked" tone="neutral" />
          <Metric label="Evidence ready" value={entries.filter((entry) => entry.evidenceStatus === 'READY').length} note="Partial evidence is visible, not silently filled" tone="good" />
          <Metric label="Auto picks" value="0" note="Research board records PASS or BLOCKED; no automatic selection" tone="neutral" />
        </div>
        </>
      )}

      {boardQuery.isLoading ? (
        <LoadingPanel rows={5} />
      ) : boardQuery.isError ? (
        <QueryMessage kind="error" onRetry={() => boardQuery.refetch()} />
      ) : !board || board.total === 0 ? (
        <Panel>
          <div className="p-8 text-center space-y-3">
            <Kicker>No research rows</Kicker>
            <h2 className="text-lg">Refresh the research engines after projected lineups have landed</h2>
            <p className="text-sm text-muted-foreground max-w-lg mx-auto">
              This view reads persisted research evidence, not browser-derived rankings. FantasyPros projections remain comparison values and never become selection inputs.
            </p>
          </div>
        </Panel>
      ) : (
        <>
        <Panel>
          <SectionHeading
            eyebrow={`${board.total} independent research rows · ${effectiveDate}`}
            title="Research evidence board"
            detail="Each row pairs an independent rank with its optional FantasyPros reference rank, readiness, and audit evidence."
          />
          <div className="table-wrap">
            <table className="data-table" data-testid="market-board-table">
              <thead>
                <tr>
                  <th>Independent rank</th>
                  <th>Player</th>
                  <th>Market</th>
                  <th>FantasyPros ref.</th>
                  <th>Comparison</th>
                  <th>Mechanism</th>
                  <th>Evidence</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.boardId}>
                    <td className="font-mono">{entry.researchRank ?? '—'}</td>
                    <td><strong>{entry.playerName}</strong></td>
                    <td><Badge tone="accent">{MARKET_LABELS[entry.market as MarketShortCode] ?? entry.market}</Badge></td>
                    <td className="font-mono">{entry.referenceRank ?? '—'}</td>
                    <td><Badge tone={entry.referenceComparison === 'DISAGREE' ? 'warn' : entry.referenceComparison === 'AGREE' ? 'good' : 'neutral'}>{entry.referenceComparison}</Badge></td>
                    <td className="text-xs">{entry.primaryMechanism ?? 'Not classified'}</td>
                    <td className="text-xs">
                      <Badge tone={toneFor(entry.evidenceStatus)}>{entry.evidenceStatus}</Badge>
                    </td>
                    <td className="text-xs">
                      <Badge tone={toneFor(entry.decisionStatus)}>{entry.decisionStatus}</Badge>
                      <div className="mt-1 opacity-70">No automatic pick or probability claim</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel className="mt-6">
          <SectionHeading
            eyebrow={`${gameSummary?.total ?? 0} games with board context`}
            title="Game summaries"
            detail="Starters, bullpen availability counts, and the highest-ranked research row for each market."
          />
          {gameQuery.isLoading ? <LoadingPanel rows={2} /> : gameQuery.isError ? (
            <QueryMessage kind="error" onRetry={() => gameQuery.refetch()} />
          ) : !gameSummary?.games.length ? (
            <QueryMessage kind="empty" />
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {gameSummary.games.map((game) => (
                <div key={game.gamePk} className="rounded border border-border p-4 space-y-3" data-testid={`game-summary-${game.gamePk}`}>
                  <div className="flex justify-between gap-2"><strong>{game.awayTeam} @ {game.homeTeam}</strong><span className="text-xs text-muted-foreground">{game.park ?? 'Park unavailable'}</span></div>
                  <p className="text-xs text-muted-foreground">
                    Starters: {game.awayStarter.name} ({game.awayStarter.state}) / {game.homeStarter.name} ({game.homeStarter.state}) ·
                    available bullpen arms: {game.bullpenContext.awayAvailableArms} / {game.bullpenContext.homeAvailableArms}
                  </p>
                  <div className="flex flex-wrap gap-2">
                      {Object.values(game.topCandidates).map((candidate) => (
                        <Badge key={candidate.boardId} tone="neutral">
                          {candidate.market} · {candidate.playerName} · research {candidate.researchState}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
        </>
      )}
    </div>
  );
}

const MECHANISM_SHORT: Record<string, string> = {
  CONTACT_VOLUME: 'CONTACT',
  POWER_ROUTE: 'POWER',
  MULTI_PATH: 'MULTI',
};

function CandidateRow({ candidate: c, index }: { candidate: MarketResearchCandidate; index: number }) {
  const tone = RESEARCH_STATE_TONE[c.researchState] ?? 'neutral';

  // Extract TB-specific evidence from JSONB blobs (present on TB candidates)
  const opp = c.opportunityEvidence as Record<string, unknown>;
  const smatch = c.starterMatchupEvidence as Record<string, unknown>;
  const counter = c.counterEvidence as Record<string, unknown>;
  const flags: string[] = Array.isArray(counter?.flags) ? counter.flags as string[] : [];

  const battingOrder = typeof opp?.battingOrder === 'number' ? opp.battingOrder : null;
  const pitcherXSLG = typeof smatch?.pitcherXSLGAllowed === 'number' ? (smatch.pitcherXSLGAllowed as number).toFixed(3) : null;

  const mechLabel = c.primaryMechanism ? (MECHANISM_SHORT[c.primaryMechanism] ?? c.primaryMechanism) : null;
  const secMechLabel = c.secondaryMechanism ? (MECHANISM_SHORT[c.secondaryMechanism] ?? c.secondaryMechanism) : null;

  return (
    <tr data-testid={`candidate-row-${index}`}>
      <td className="number font-mono">{c.researchRank ?? '—'}</td>
      <td><strong>{c.playerName}</strong></td>
      <td><span className="badge badge-neutral font-mono text-xs">{c.market}</span></td>
      <td><Badge tone={tone}>{c.researchState}</Badge></td>
      <td className="text-xs">
        {mechLabel ? (
          <span className="flex items-center gap-1">
            <span className="badge badge-accent font-mono">{mechLabel}</span>
            {secMechLabel && <span className="text-muted-foreground">+{secMechLabel}</span>}
          </span>
        ) : <em className="text-muted-foreground">—</em>}
      </td>
      <td className="font-mono text-xs text-center">
        {battingOrder !== null ? battingOrder : <em className="text-muted-foreground">—</em>}
      </td>
      <td className="font-mono text-xs text-center">
        {pitcherXSLG !== null ? (
          <span className={Number(pitcherXSLG) >= 0.430 ? 'text-good' : Number(pitcherXSLG) < 0.360 ? 'text-bad' : ''}>
            {pitcherXSLG}
          </span>
        ) : <em className="text-muted-foreground">—</em>}
      </td>
      <td className="text-xs">
        {flags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {flags.map((f) => (
              <span key={f} className="badge badge-warn font-mono text-[10px]">{f.replace(/_/g, ' ')}</span>
            ))}
          </div>
        ) : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="text-xs text-muted-foreground max-w-[160px] truncate">
        {c.missingStaleEvidence ?? '—'}
      </td>
    </tr>
  );
}


function BettorIntelligencePage() {
  const [sourceId, setSourceId] = useState('');
  const [market, setMarket] = useState<BettorEvaluationPickMarket | ''>('');

  const query = useGetAnalystBettorEvaluation({
    sourceId: sourceId || undefined,
    market: market || undefined
  });

  const data = query.data as BettorEvaluation | undefined;

  return (
    <div className="page-content rise-in">
      <div className="page-intro">
        <div>
          <Kicker>Observational analysis</Kicker>
          <h1>Bettor <span className="slash">//</span> intelligence</h1>
          <p>
            Evaluation is observational only and never changes model training or confidence labels.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="select-wrap relative w-48">
            <select value={sourceId} onChange={e => setSourceId(e.target.value)} data-testid="select-source">
              <option value="">All Sources</option>
              {data?.sources?.map(s => <option key={s.sourceId} value={s.sourceId}>{s.accountHandle}</option>)}
            </select>
          </div>
          <div className="select-wrap relative w-48">
            <select value={market} onChange={e => setMarket(e.target.value as any)} data-testid="select-market">
              <option value="">All Markets</option>
              <option value="TB">TB</option>
              <option value="XBH">XBH</option>
              <option value="WALK">WALK</option>
              <option value="HR">HR</option>
            </select>
          </div>
          <button className="button button-dark" onClick={() => query.refetch()} disabled={query.isRefetching} data-testid="button-refresh">
            <RefreshCw size={15} className={query.isRefetching ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {query.isLoading ? <LoadingPanel rows={6} /> : query.isError ? <QueryMessage kind="error" onRetry={() => query.refetch()} /> : !data ? <QueryMessage kind="empty" /> : (
        <>
          <div className="metric-grid">
            <Metric label="Total sources" value={data.sources.length} note="Tracked" tone="neutral" />
            <Metric label="Total records" value={data.totalRecords} note="Aggregated" tone="neutral" />
            <Metric label="Total picks" value={data.totalPicks} note="Ingested" tone="neutral" />
            <Metric label="Evaluation Window" value={data.evaluationWindow} note={data.computedAt.slice(11, 16) + 'z'} tone="accent" />
          </div>

          <Panel className="mb-6">
            <SectionHeading eyebrow="Source Comparison" title="Leaderboard & Mechanism Breakdown" detail="Aggregated performance by source, market, and primary mechanism." />
            {data.records.length > 0 ? (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th>Platform</th>
                      <th>Market</th>
                      <th>Mechanism</th>
                      <th className="number">Picks</th>
                      <th className="number">Settled</th>
                      <th className="number">Outcome Rate</th>
                      <th className="number">Delta</th>
                      <th className="number">Indep. Score</th>
                      <th className="number">Adj. Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.records.map(record => (
                      <tr key={record.performanceRecordId} data-testid={"record-" + record.performanceRecordId}>
                        <td><strong>{record.source.accountHandle}</strong></td>
                        <td>{record.source.platform}</td>
                        <td className="market-cell">{record.market}</td>
                        <td><Badge tone="neutral">{record.mechanism}</Badge></td>
                        <td className="number">{record.pickCount}</td>
                        <td className="number">{record.settledPickCount}</td>
                        <td className="number">{(record.outcomeRate * 100).toFixed(1)}%</td>
                        <td className="number">
                          <span className={record.baseRateDelta > 0 ? 'text-accent' : record.baseRateDelta < 0 ? 'text-destructive' : ''}>
                            {record.baseRateDelta > 0 ? '+' : ''}{(record.baseRateDelta * 100).toFixed(1)}%
                          </span>
                        </td>
                        <td className="number">{(record.independenceScore * 100).toFixed(0)}%</td>
                        <td className="number">{record.duplicationAdjustedCount.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <QueryMessage kind="empty" />}
          </Panel>

          <Panel>
            <SectionHeading eyebrow="Pick History" title="Settled vs Predicted" detail="Line-item historical evidence and copy-detection flags." />
            {data.picks.length > 0 ? (
               <div className="table-wrap">
               <table className="data-table">
                 <thead>
                   <tr>
                     <th>Date</th>
                     <th>Player</th>
                     <th>Market</th>
                     <th>Direction</th>
                     <th>Mechanism</th>
                     <th>Source</th>
                     <th>Duplication</th>
                     <th>Prediction</th>
                   </tr>
                 </thead>
                 <tbody>
                   {data.picks.map(pick => (
                     <tr key={pick.pickId} data-testid={"pick-" + pick.pickId}>
                       <td>{pick.slateDate}</td>
                       <td><strong>{pick.playerName}</strong></td>
                       <td className="market-cell">{pick.market}</td>
                       <td>{pick.pickDirection}</td>
                       <td>{pick.mechanismTags.join(', ') || 'NONE'}</td>
                       <td>{pick.source.accountHandle}</td>
                       <td>
                         {pick.isLikelyCopy ? (
                           <Badge tone="warn">{pick.duplicationFlag}</Badge>
                         ) : (
                           <Badge tone="good">{pick.duplicationFlag}</Badge>
                         )}
                       </td>
                       <td>
                         {pick.predictionCorrect === true ? (
                           <Badge tone="good">CORRECT</Badge>
                         ) : pick.predictionCorrect === false ? (
                           <Badge tone="bad">INCORRECT</Badge>
                         ) : (
                           <Badge tone="neutral">PENDING</Badge>
                         )}
                       </td>
                     </tr>
                   ))}
                 </tbody>
               </table>
             </div>
            ) : <QueryMessage kind="empty" />}
          </Panel>
        </>
      )}
    </div>
  );
}

function AiAnalystPage() {
  const [sessionId, setSessionId] = useState(() => localStorage.getItem('mlb-ai-analyst-session') || `operator-${crypto.randomUUID()}`);
  const [question, setQuestion] = useState('');
  const [claimNote, setClaimNote] = useState('');
  const [history, setHistory] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const approvalKeyRef = useRef<HTMLInputElement>(null);
  const [approvalReady, setApprovalReady] = useState(false);
  const [latestResponse, setLatestResponse] = useState<{ response: string; sourcingClaimIds: string[]; toolName: string } | null>(null);

  const chat = useChatWithAnalystAi();
  const drafts = useGetAnalystAiDrafts({ sessionId });
  const claims = useGetAnalystAiSourcingRegister({ sessionId });
  const notes = useGetAnalystAiResearchNotes({ sessionId });
  const createDraft = useCreateAnalystAiDraft();
  const approveDraft = useApproveAnalystAiDraft();
  const rejectDraft = useRejectAnalystAiDraft();
  const decideClaim = useDecideAnalystAiSourcingClaim();

  const refreshReviewData = () => {
    drafts.refetch();
    claims.refetch();
    notes.refetch();
  };

  const unlockReview = async () => {
    const approvalKey = approvalKeyRef.current?.value ?? '';
    if (!approvalKey) return;
    const response = await fetch('/api/analyst/ai/operator-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvalKey }),
    });
    if (response.ok) {
      approvalKeyRef.current!.value = '';
      setApprovalReady(true);
    }
  };

  const submitQuestion = () => {
    const message = question.trim();
    if (!message || chat.isPending) return;
    chat.mutate(
      { data: { sessionId, message } },
      {
        onSuccess: (result) => {
          const nextEntries: Array<{ role: 'user' | 'assistant'; content: string }> = [
            { role: 'user', content: message },
            { role: 'assistant', content: result.response },
          ];
          setHistory((current) => [...current, ...nextEntries].slice(-8));
          setLatestResponse({ response: result.response, sourcingClaimIds: result.sourcingClaimIds, toolName: result.toolName });
          setQuestion('');
          claims.refetch();
        },
      },
    );
  };

  const saveDraft = () => {
    if (!latestResponse || createDraft.isPending) return;
    createDraft.mutate(
      { data: { sessionId, draftContent: latestResponse.response, sourceClaimIds: latestResponse.sourcingClaimIds } },
      { onSuccess: () => drafts.refetch() },
    );
  };

  const reviewDraft = (draftId: string, approved: boolean) => {
    if (!approvalReady) return;
    const mutation = approved ? approveDraft : rejectDraft;
    mutation.mutate(
      {
        draftId,
        data: approved
          ? { reviewedBy: 'SESSION_OPERATOR' }
          : { reviewedBy: 'SESSION_OPERATOR', rejectionReason: 'Operator rejected this AI-sourced research draft.' },
      },
      { onSuccess: refreshReviewData },
    );
  };

  const reviewClaim = (claimId: string, accepted: boolean) => {
    if (!approvalReady) return;
    decideClaim.mutate(
      {
        claimId,
        data: {
          accepted,
          reviewedBy: 'SESSION_OPERATOR',
          ...(accepted ? {} : { rejectionReason: claimNote.trim() || 'Operator rejected this sourced claim.' }),
          ...(claimNote.trim() ? { operatorNote: claimNote.trim() } : {}),
        },
      },
      { onSuccess: () => { claims.refetch(); setClaimNote(''); } },
    );
  };

  const pendingDrafts = drafts.data?.drafts.filter((draft) => draft.status === 'DRAFT') ?? [];
  const pendingClaims = claims.data?.claims.filter((claim) => claim.accepted === null) ?? [];

  return (
    <div className="page-content rise-in" data-testid="page-ai-analyst">
      <div className="page-intro">
        <div>
          <Kicker>Tool-grounded workflow</Kicker>
          <h1>AI <span className="slash">//</span> analyst</h1>
          <p>Answers are limited to audited read tools. Drafts and cited claims remain unapproved until an operator records a decision.</p>
        </div>
        <button className="button button-quiet" onClick={refreshReviewData} data-testid="button-refresh-ai-workflow">
          <RefreshCw size={15} /> Refresh review data
        </button>
      </div>

      <div className="ai-workspace">
        <Panel className="ai-chat-panel">
          <SectionHeading eyebrow="Conversation" title="Ask the evidence layer" detail="The assistant selects a bounded read tool and explains only its returned evidence." />
          <form className="ai-session-row" onSubmit={(event) => event.preventDefault()}>
            <label>Session
              <input value={sessionId} onChange={(event) => { setSessionId(event.target.value); localStorage.setItem('mlb-ai-analyst-session', event.target.value); }} data-testid="input-ai-session" />
            </label>
            <label>Review identity
              <input value="Authorized review operator" readOnly aria-label="Review identity" />
            </label>
            <label>Approval key
              <input ref={approvalKeyRef} type="password" autoComplete="current-password" placeholder="Unlocks a 15-minute review session" data-testid="input-ai-approval-key" />
            </label>
            <button className="button button-quiet" type="button" onClick={unlockReview}>{approvalReady ? 'Review unlocked' : 'Unlock review'}</button>
          </form>
          <div className="ai-transcript" data-testid="ai-transcript">
            {history.length === 0 && <div className="ai-empty"><Sparkles size={18} /><p>Ask about today’s market board, a bullpen, settlements, snapshots, bettor picks, or recent web research.</p></div>}
            {history.map((entry, index) => (
              <article key={`${entry.role}-${index}`} className={`ai-message ai-message-${entry.role}`} data-testid={`ai-message-${entry.role}-${index}`}>
                <span>{entry.role === 'user' ? 'Operator' : 'AI analyst'}</span>
                <p>{entry.content}</p>
              </article>
            ))}
            {chat.isPending && <article className="ai-message ai-message-assistant" data-testid="ai-thinking"><span>AI analyst</span><p>Running a permitted read tool…</p></article>}
          </div>
          {chat.isError && <div className="query-message query-error" data-testid="ai-chat-error"><AlertTriangle size={18} /><div><strong>AI response unavailable</strong><p>Check the research source or try a narrower prompt.</p></div></div>}
          <div className="ai-composer">
            <textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitQuestion(); } }} placeholder="Ask a tool-grounded research question…" data-testid="input-ai-question" />
            <button className="button button-dark" onClick={submitQuestion} disabled={!question.trim() || chat.isPending} data-testid="button-send-ai-question"><Send size={15} /> Ask</button>
          </div>
          {latestResponse && (
            <div className="ai-evidence-bar" data-testid="ai-latest-evidence">
              <div><Badge tone="accent">{latestResponse.toolName}</Badge><span>{latestResponse.sourcingClaimIds.length} cited web claim{latestResponse.sourcingClaimIds.length === 1 ? '' : 's'} awaiting review</span></div>
              <button className="button button-quiet" onClick={saveDraft} disabled={createDraft.isPending} data-testid="button-save-ai-draft"><FilePlus size={15} /> Save as draft</button>
            </div>
          )}
        </Panel>

        <aside className="ai-review-sidebar">
          <Panel>
            <SectionHeading eyebrow="Human gate" title="Draft review queue" detail={`${pendingDrafts.length} awaiting a human decision`} />
            <div className="ai-queue">
              {drafts.isLoading ? <LoadingPanel rows={2} /> : pendingDrafts.length === 0 ? <p className="ai-muted">No unapproved drafts in this session.</p> : pendingDrafts.map((draft) => (
                <article className="ai-queue-card" key={draft.draftId} data-testid={`ai-draft-${draft.draftId}`}>
                  <Badge tone="warn">DRAFT</Badge>
                  <p>{draft.draftContent}</p>
                  <div className="ai-queue-actions">
                    <button className="button button-dark" onClick={() => reviewDraft(draft.draftId, true)} disabled={!approvalReady || approveDraft.isPending} data-testid={`button-approve-draft-${draft.draftId}`}><Check size={14} /> Approve</button>
                    <button className="button button-quiet" onClick={() => reviewDraft(draft.draftId, false)} disabled={!approvalReady || rejectDraft.isPending} data-testid={`button-reject-draft-${draft.draftId}`}><X size={14} /> Reject</button>
                  </div>
                </article>
              ))}
            </div>
          </Panel>

          <Panel>
            <SectionHeading eyebrow="Approved stream" title="Research notes" detail={`${notes.data?.total ?? 0} human-approved AI notes`} />
            <div className="ai-queue">
              {notes.isLoading ? <LoadingPanel rows={2} /> : notes.data?.notes.length ? notes.data.notes.slice(0, 4).map((note) => (
                <article className="ai-queue-card ai-note" key={note.noteId} data-testid={`ai-note-${note.noteId}`}>
                  <Badge tone="good">APPROVED</Badge><p>{note.noteContent}</p><small>Approved by {note.approvedBy}</small>
                </article>
              )) : <p className="ai-muted">Approved AI notes will appear here without changing frozen research.</p>}
            </div>
          </Panel>
        </aside>
      </div>

      <Panel className="mt-6">
        <SectionHeading eyebrow="Sourcing register" title="Claims needing an operator decision" detail="Web claims are discoverable, not accepted evidence, until a human records a disposition." />
        <div className="ai-claim-toolbar">
          <input value={claimNote} onChange={(event) => setClaimNote(event.target.value)} placeholder="Decision note or rejection reason" data-testid="input-claim-decision-note" />
          <span>{pendingClaims.length} pending</span>
        </div>
        {claims.isLoading ? <LoadingPanel rows={3} /> : claims.isError ? <QueryMessage kind="error" onRetry={() => claims.refetch()} /> : claims.data?.claims.length ? (
          <div className="ai-claims-list">
            {claims.data.claims.map((claim) => (
              <article className="ai-claim" key={claim.claimId} data-testid={`ai-claim-${claim.claimId}`}>
                <div className="ai-claim-copy">
                  <div><Badge tone={claim.accepted === null ? 'warn' : claim.accepted ? 'good' : 'bad'}>{claim.accepted === null ? 'PENDING' : claim.accepted ? 'ACCEPTED' : 'REJECTED'}</Badge> <Badge tone="neutral">{claim.sourceType}</Badge></div>
                  <p>{claim.claimText}</p>
                  <a href={claim.sourceUrlOrDescription} target="_blank" rel="noreferrer" data-testid={`link-claim-source-${claim.claimId}`}><ExternalLink size={13} /> View cited source</a>
                  {claim.operatorNote && <small>Operator note: {claim.operatorNote}</small>}
                </div>
                {claim.accepted === null && <div className="ai-claim-actions">
                  <button className="button button-dark" onClick={() => reviewClaim(claim.claimId, true)} disabled={!approvalReady || decideClaim.isPending} data-testid={`button-accept-claim-${claim.claimId}`}><ThumbsUp size={14} /> Accept</button>
                  <button className="button button-quiet" onClick={() => reviewClaim(claim.claimId, false)} disabled={!approvalReady || decideClaim.isPending} data-testid={`button-reject-claim-${claim.claimId}`}><ThumbsDown size={14} /> Reject</button>
                </div>}
              </article>
            ))}
          </div>
        ) : <QueryMessage kind="empty" />}
      </Panel>
    </div>
  );
}

function Router() {
  return (
    <AppShell>
      <ErrorBoundary resetKey={window.location.pathname}>
        <Switch>
          <Route path="/" component={DashboardPage} />
          <Route path="/projection-center" component={ProjectionsPage} />
          <Route path="/data-health" component={DataHealthPage} />
          <Route path="/orchestration" component={OrchestrationPage} />
          <Route path="/audit-trail" component={AuditTrailPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route path="/round-robin" component={RoundRobinPage} />
          <Route path="/game-lab" component={GameLabPage} />
          <Route path="/player-lab" component={PlayerLabPage} />
          <Route path="/pitcher-lab" component={PitcherLabPage} />
          <Route path="/bullpen-room" component={BullpenRoomPage} />
          <Route path="/market-board" component={MarketBoardPage} />
          <Route path="/feature-store" component={FeatureStorePage} />
          <Route path="/bettor-intelligence" component={BettorIntelligencePage} />
          <Route path="/model-lab">{() => <FuturePage label="Model lab" />}</Route>
          <Route path="/ai-analyst" component={AiAnalystPage} />
          <Route path="/results">{() => <FuturePage label="Results" />}</Route>
          <Route component={NotFound} />
        </Switch>
      </ErrorBoundary>
    </AppShell>
  );
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;
