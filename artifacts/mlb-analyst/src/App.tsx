import { type ReactNode, useMemo, useState } from 'react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useGetAnalystDataHealth, useGetAnalystMarketResearch, useGetAnalystProjections, useGetAnalystSettings, useGetAnalystToday, useRefreshFantasyPros, useRefreshMlbOfficial, useGetAnalystPlayerLab, useGetAnalystPitcherLab, useGetAnalystGameLab, useRefreshAnalystResearch, useGetAnalystBullpenRoom, useRefreshBullpen, useRefreshMarketResearchTB } from '@workspace/api-client-react';
import type { AnalystSettings, BullpenArm, BullpenRoom, BullpenTeam, DataHealth, HealthIssue, MarketResearch, MarketResearchCandidate, MarketShortCode, ProjectionCenter, ProjectionRow, ResearchState, SlateGame, SourceBadge, TBEngineResult, TodayDashboard, ResearchMetric, ResearchSearchResult, ResearchProfile } from '@workspace/api-client-react';
import { Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3, Bell, BookOpen, CalendarDays, Check, ChevronRight, Cloud, Database, Gauge, GitBranch, Home, LineChart, LockKeyhole, Menu, RefreshCw, Server, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Table2, Target, X, Search, ArrowRight } from 'lucide-react';
import { Link, Route, Switch, useLocation, useSearch, Router as WouterRouter } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();

type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'accent';

const navGroups: { label: string; items: Array<{ href: string; label: string; icon: typeof Home; future?: boolean }> }[] = [
  {
    label: 'Operations',
    items: [
      { href: '/', label: 'Today', icon: Home },
      { href: '/projection-center', label: 'Projection center', icon: LineChart },
      { href: '/data-health', label: 'Data health', icon: Database },
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
      { href: '/bettor-intelligence', label: 'Bettor intelligence', icon: Gauge, future: true },
      { href: '/model-lab', label: 'Model lab', icon: GitBranch, future: true },
      { href: '/ai-analyst', label: 'AI analyst', icon: Sparkles, future: true },
      { href: '/results', label: 'Results', icon: Table2, future: true },
    ],
  },
];

function toneFor(value: string | null | undefined): Tone {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized.includes('good') || normalized.includes('ready') || normalized.includes('fresh') || normalized.includes('healthy') || normalized.includes('complete') || normalized.includes('configured') || normalized.includes('active')) return 'good';
  if (normalized.includes('warn') || normalized.includes('stale') || normalized.includes('partial') || normalized.includes('pending') || normalized.includes('degraded')) return 'warn';
  if (normalized.includes('error') || normalized.includes('fail') || normalized.includes('missing') || normalized.includes('blocked') || normalized.includes('critical')) return 'bad';
  return 'neutral';
}

function StatusDot({ tone = 'neutral', pulse = false }: { tone?: Tone; pulse?: boolean }) {
  return <span className={`status-dot status-${tone} ${pulse ? 'status-pulse' : ''}`} aria-hidden="true" />;
}

function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`badge badge-${tone}`} data-testid="status-badge">{children}</span>;
}

function Panel({ children, className = '', ...props }: { children: ReactNode; className?: string; [key: string]: unknown }) {
  return <section className={`panel ${className}`} {...props}>{children}</section>;
}

function Kicker({ children }: { children: ReactNode }) {
  return <div className="kicker">{children}</div>;
}

function SectionHeading({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail?: string; action?: ReactNode }) {
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

function LoadingPanel({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" data-testid="loading-state">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="skeleton h-16 w-full rounded-sm" />
      ))}
    </div>
  );
}

function QueryMessage({ kind, onRetry }: { kind: 'error' | 'empty'; onRetry?: () => void }) {
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
        {!compact && <small>{source.rowCount.toLocaleString()} rows</small>}
      </div>
    </div>
  );
}

function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const pageTitle = useMemo(() => navGroups.flatMap((group) => group.items).find((item) => item.href === location)?.label ?? 'Analyst platform', [location]);

  return (
    <div className="app-noise min-h-[100dvh]">
      <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
        <div className="brand-block">
          <div className="brand-mark">M</div>
          <div><strong>MLB / OPS</strong><span>Analyst platform</span></div>
          <button className="mobile-close" onClick={() => setMobileOpen(false)} data-testid="button-close-navigation"><X size={18} /></button>
        </div>
        <div className="rail-status"><StatusDot tone="good" pulse /><span>Systems nominal</span><small>PHASE 01</small></div>
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
            <div className="live-clock"><span className="live-pip" /> LIVE <span className="clock-divider">/</span> {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
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
      <div className="game-details"><span><Cloud size={13} /> {game.weather}</span><span><span className="diamond-mark" /> {game.park}</span><span className="lineup-state"><StatusDot tone={toneFor(game.lineupState)} /> {game.lineupState}</span></div>
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
  const query = useGetAnalystDataHealth();
  const data = query.data as DataHealth | undefined;
  const criticalCount = data?.issues?.filter((issue) => toneFor(issue.severity) === 'bad').length ?? 0;
  const coverage = data?.identityCoverage;
  return (
    <div className="page-content rise-in">
      <div className="page-intro">
        <div><Kicker>Provenance / freshness / mappings</Kicker><h1>Data <span className="slash">//</span> health</h1><p>Know what arrived, when it arrived, and what still needs an analyst’s eyes.</p></div>
        <button className="button button-dark" onClick={() => query.refetch()} data-testid="button-refresh-data-health"><RefreshCw size={15} /> Run health check</button>
      </div>
      {query.isLoading ? <LoadingPanel rows={6} /> : query.isError ? <QueryMessage kind="error" onRetry={() => query.refetch()} /> : !data ? <QueryMessage kind="empty" /> : (
        <>
          <div className="health-summary">
            <Panel className="overall-panel"><div className="health-ring"><Gauge size={25} /><span>{data.overall}</span></div><div><Kicker>Overall contract state</Kicker><h2>{data.overall}</h2><p>Last run {data.lastRun}</p></div><div className="health-rule" /></Panel>
            <Metric label="Sources observed" value={data.sources?.length ?? 0} note="In current health run" tone="accent" />
            <Metric label="Issues requiring review" value={data.issues?.length ?? 0} note={criticalCount ? `${criticalCount} critical` : 'No critical issues'} tone={criticalCount ? 'bad' : data.issues?.length ? 'warn' : 'good'} />
          </div>
          <Panel>
            <SectionHeading eyebrow="Current player eligibility" title="Slate identity coverage" detail="Coverage is measured against official starters, posted lineups, projected lineups, and the current eligible projection universe." />
            <div className="metric-grid">
              <Metric label="Official starters" value={`${coverage?.officialStartersMapped ?? 0}/${coverage?.officialStartersTotal ?? 0}`} note="Canonical identities" tone={(coverage?.officialStartersMapped ?? 0) === (coverage?.officialStartersTotal ?? 0) ? 'good' : 'bad'} />
              <Metric label="Posted lineups" value={(coverage?.officialLineupPlayersTotal ?? 0) === 0 ? 'N/A' : `${coverage?.officialLineupPlayersMapped ?? 0}/${coverage?.officialLineupPlayersTotal ?? 0}`} note={(coverage?.officialLineupPlayersTotal ?? 0) === 0 ? 'NO OFFICIAL LINEUPS POSTED' : 'Official lineup players'} tone={(coverage?.officialLineupPlayersTotal ?? 0) === 0 ? 'neutral' : (coverage?.officialLineupPlayersMapped ?? 0) === (coverage?.officialLineupPlayersTotal ?? 0) ? 'good' : 'bad'} />
              <Metric label="Projected lineups" value={`${coverage?.projectedLineupPlayersMapped ?? 0}/${coverage?.projectedLineupPlayersTotal ?? 0}`} note={coverage?.blockingProjectedLineupIssues ? `${coverage.blockingProjectedLineupIssues} blocking issue(s)` : 'No blocking identity issue'} tone={coverage?.blockingProjectedLineupIssues ? 'bad' : 'good'} />
              <Metric label="Active projections" value={`${coverage?.activeProjectionPlayersMapped ?? 0}/${coverage?.activeProjectionPlayersTotal ?? 0}`} note={`${coverage?.unresolvedActivePlayers ?? 0} unresolved active`} tone={(coverage?.unresolvedActivePlayers ?? 0) ? 'warn' : 'good'} />
              <Metric label="Quarantined rows" value={coverage?.quarantinedRows ?? 0} note="Raw rows retained for audit" tone={(coverage?.quarantinedRows ?? 0) ? 'warn' : 'good'} />
              <Metric label="Team conflicts" value={coverage?.teamAssignmentConflicts ?? 0} note="Source team vs official org" tone={(coverage?.teamAssignmentConflicts ?? 0) ? 'warn' : 'good'} />
            </div>
          </Panel>
          <Panel>
            <SectionHeading eyebrow="Research layer" title="Analyst lab metrics" detail="Evidence, profiles, and analytical lab data quality." />
            <div className="metric-grid">
              <Metric label="Hitter evidence" value={`${data.researchHealth?.playerProfiles ?? 0}/${data.researchHealth?.eligibleHitterProfiles ?? 0}`} note={`${data.researchHealth?.hitterProfilesMissingEvidence ?? 0} eligible shells lack source evidence`} tone={(data.researchHealth?.hitterProfilesMissingEvidence ?? 0) > 0 ? 'warn' : 'good'} />
              <Metric label="Pitcher evidence" value={`${data.researchHealth?.pitcherProfiles ?? 0}/${data.researchHealth?.eligiblePitcherProfiles ?? 0}`} note={`${data.researchHealth?.pitcherProfilesMissingEvidence ?? 0} eligible shells lack source evidence`} tone={(data.researchHealth?.pitcherProfilesMissingEvidence ?? 0) > 0 ? 'warn' : 'good'} />
              <Metric label="Park contexts" value={`${data.researchHealth?.parkProfiles ?? 0}/${data.researchHealth?.parkRequiredVenues ?? 0}`} note={`${data.researchHealth?.parkVenueCoverageGaps ?? 0} current-game venue gap(s) across All/L/R raw components`} tone={(data.researchHealth?.parkVenueCoverageGaps ?? 0) > 0 ? 'bad' : 'good'} />
              <Metric label="Stale windows" value={data.researchHealth?.staleWindows ?? 0} note="Requires refresh" tone={(data.researchHealth?.staleWindows ?? 0) > 0 ? 'warn' : 'good'} />
              <Metric label="Quarantined records" value={data.researchHealth?.identityQuarantines ?? 0} note="ID mapping failed" tone={(data.researchHealth?.identityQuarantines ?? 0) > 0 ? 'bad' : 'good'} />
              <Metric label="Insufficient samples" value={data.researchHealth?.insufficientSamples ?? 0} note="Statistically suppressed" tone={(data.researchHealth?.insufficientSamples ?? 0) > 0 ? 'warn' : 'good'} />
              <Metric label="Opponent-hand splits" value={`${data.researchHealth?.handednessCoveredPlayers ?? 0}/${data.researchHealth?.handednessTargetPlayers ?? 0}`} note="Full official eligible hitter/pitcher universe; explicit L/R Statcast panels" tone={(data.researchHealth?.missingHandednessSplits ?? 0) > 0 ? 'bad' : 'good'} />
              <Metric label="Definition conflicts" value={data.researchHealth?.metricDefinitionConflicts ?? 0} note="Formula mismatch" tone={(data.researchHealth?.metricDefinitionConflicts ?? 0) > 0 ? 'bad' : 'good'} />
            </div>
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

function HealthSource({ source }: { source: SourceBadge }) {
  const tone = toneFor(source.status);
  return <div className="health-source" data-testid={`health-source-${source.name.replaceAll(' ', '-').toLowerCase()}`}><div className="health-source-head"><div className="source-title"><StatusDot tone={tone} /><strong>{source.name}</strong></div><Badge tone={tone}>{source.freshness}</Badge></div><div className="health-bar"><span className={`health-bar-fill fill-${tone}`} style={{ width: tone === 'good' ? '92%' : tone === 'warn' ? '64%' : '28%' }} /></div><div className="health-source-foot"><span>{source.detail}</span><code>{source.rowCount.toLocaleString()} rows</code></div></div>;
}

function IssueRow({ issue }: { issue: HealthIssue }) {
  const tone = toneFor(issue.severity);
  return <div className={`issue-row issue-${tone}`} data-testid={`issue-${issue.label.replaceAll(' ', '-').toLowerCase()}`}><div className="issue-icon">{tone === 'bad' ? <X size={15} /> : <AlertTriangle size={15} />}</div><div className="flex-1"><div className="issue-head"><strong>{issue.label}</strong><Badge tone={tone}>{issue.severity}</Badge></div><p>{issue.detail}</p></div><ChevronRight size={15} className="text-muted" /></div>;
}

function SettingsPage() {
  const query = useGetAnalystSettings();
  const data = query.data as AnalystSettings | undefined;
  const [cadence, setCadence] = useState('');
  const [market, setMarket] = useState('');
  const [saved, setSaved] = useState(false);
  const activeCadence = cadence || data?.refreshCadence || '';
  const activeMarket = market || data?.defaultMarket || '';
  function savePreferences() {
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2200);
  }
  return (
    <div className="page-content page-settings rise-in">
      <div className="page-intro">
        <div><Kicker>Control plane / safe metadata</Kicker><h1>Settings <span className="slash">//</span> preferences</h1><p>Connection state is readable here. Secrets and write actions are intentionally out of scope for Phase 1.</p></div>
        <div className="safe-readonly"><LockKeyhole size={14} /> Read-only controls</div>
      </div>
      {query.isLoading ? <LoadingPanel rows={5} /> : query.isError ? <QueryMessage kind="error" onRetry={() => query.refetch()} /> : !data ? <QueryMessage kind="empty" /> : (
        <div className="settings-layout">
          <Panel><SectionHeading eyebrow="Connections" title="Source access" detail="No credentials are rendered in the analyst surface." /><div className="connection-list">{data.connections?.length ? data.connections.map((connection) => <div className="connection-row" key={connection.name} data-testid={`connection-${connection.name.replaceAll(' ', '-').toLowerCase()}`}><div className={`connection-icon ${connection.configured ? 'connection-on' : ''}`}>{connection.configured ? <Check size={16} /> : <LockKeyhole size={16} />}</div><div className="flex-1"><div className="connection-head"><strong>{connection.name}</strong><Badge tone={connection.configured ? 'good' : 'warn'}>{connection.configured ? 'Configured' : 'Not configured'}</Badge></div><p>{connection.detail}</p></div><span className="connection-chevron"><ChevronRight size={15} /></span></div>) : <QueryMessage kind="empty" />}</div><div className="settings-note"><ShieldCheck size={16} /><span>Tokens, keys, and secrets remain server-side. This panel only reports safe connection metadata.</span></div></Panel>
          <Panel className="preference-panel"><SectionHeading eyebrow="Analyst defaults" title="Working preferences" detail="Stored values shape future reads of the platform." /><div className="preference-form"><label htmlFor="timezone">Timezone<span>Used for slate timestamps</span></label><div className="select-wrap"><select id="timezone" defaultValue={data.timezone} data-testid="select-timezone"><option value={data.timezone}>{data.timezone}</option></select><ChevronRight size={15} /></div><label htmlFor="market">Default market<span>Projection display context</span></label><div className="select-wrap"><select id="market" value={activeMarket} onChange={(event) => setMarket(event.target.value)} data-testid="select-default-market"><option value={data.defaultMarket}>{data.defaultMarket}</option><option value="Fantasy points">Fantasy points</option><option value="Runs + RBI">Runs + RBI</option></select><ChevronRight size={15} /></div><label htmlFor="cadence">Refresh cadence<span>How often the workspace checks</span></label><div className="select-wrap"><select id="cadence" value={activeCadence} onChange={(event) => setCadence(event.target.value)} data-testid="select-refresh-cadence"><option value={data.refreshCadence}>{data.refreshCadence}</option><option value="Manual">Manual</option><option value="Every 15 minutes">Every 15 minutes</option><option value="Hourly">Hourly</option></select><ChevronRight size={15} /></div><button className="button button-yellow save-button" onClick={savePreferences} data-testid="button-save-preferences">{saved ? <><Check size={15} /> Preferences staged</> : <>Save preferences <ArrowUpRight size={15} /></>}</button></div></Panel>
        </div>
      )}
    </div>
  );
}

function FuturePage({ label }: { label: string }) {
  return <div className="future-page rise-in"><div className="future-mark-large">F2</div><Kicker>Future phase destination</Kicker><h1>{label}</h1><p>This room is mapped in the navigation, but its data contract has not shipped in Phase 1. Nothing is simulated here.</p><Link href="/" className="button button-dark" data-testid="link-return-to-today"><Home size={15} /> Return to Today</Link><div className="future-foot"><GitBranch size={15} /> Available when its source contract is defined <span>—</span> no invented data</div></div>;
}


function LabSearchPanel({ searchInput, setSearchInput, onSearch, results, onSelect, selectedId, placeholder = "Search entities..." }: { searchInput: string, setSearchInput: (s: string) => void, onSearch: (e: React.FormEvent) => void, results?: ResearchSearchResult[], onSelect: (id: number) => void, selectedId?: number, placeholder?: string }) {
  return (
    <Panel className="lab-sidebar">
      <SectionHeading eyebrow="Entity resolution" title="Directory" />
      <div className="px-[21px] pb-[21px]">
        <form onSubmit={onSearch} className="search-box">
          <input type="search" className="search-input" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder={placeholder} data-testid="input-lab-search" />
          <button type="submit" className="button button-dark" data-testid="button-lab-search"><Search size={14} /></button>
        </form>
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
        {results && results.length === 0 && (
          <p className="text-muted-foreground text-xs font-mono">No records matched.</p>
        )}
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

function PlayerLabPage() {
  const [location, setLocation] = useLocation();
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const playerIdParam = params.get('playerId');
  const playerId = playerIdParam ? parseInt(playerIdParam, 10) : undefined;
  const search = params.get('search') || undefined;
  const windowParam = (params.get('window') || 'SEASON') as any;
  const dateParam = params.get('date') || undefined;

  const [searchInput, setSearchInput] = useState(search || '');

  const query = useGetAnalystPlayerLab({ playerId, search, window: windowParam, date: dateParam });
  const data = query.data;
  
  const refresh = useRefreshAnalystResearch();

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const newParams = new URLSearchParams(searchString);
    if (searchInput) newParams.set('search', searchInput);
    else newParams.delete('search');
    newParams.delete('playerId');
    setLocation(`${location}?${newParams.toString()}`);
  };

  const handleSelect = (id: number) => {
    const newParams = new URLSearchParams(searchString);
    newParams.set('playerId', id.toString());
    setLocation(`${location}?${newParams.toString()}`);
  };

  const handleWindowChange = (w: string) => {
    const newParams = new URLSearchParams(searchString);
    newParams.set('window', w);
    setLocation(`${location}?${newParams.toString()}`);
  };
  const handleDateChange = (date: string) => {
    const newParams = new URLSearchParams(searchString);
    if (date) newParams.set('date', date); else newParams.delete('date');
    setLocation(`${location}?${newParams.toString()}`);
  };

  return (
    <div className="page-content rise-in">
      <div className="page-intro">
        <div>
          <Kicker>Hitter inspection</Kicker>
          <h1>Player <span className="slash">//</span> lab</h1>
          <p>Canonical hitter research profiles. Provenance-backed evidence, zero synthetic predictions.</p>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" className="search-input !h-[35px] !w-auto" value={dateParam || data?.profile?.effectiveTo.slice(0, 10) || ''} onChange={(e) => handleDateChange(e.target.value)} data-testid="input-player-lab-date" />
          <button className="button button-dark" onClick={() => refresh.mutate({})} disabled={refresh.isPending} data-testid="button-refresh-research">
            <RefreshCw size={15} /> {refresh.isPending ? 'Ingesting...' : 'Sync statcast/fangraphs'}
          </button>
        </div>
      </div>

      <div className="lab-layout">
        <LabSearchPanel 
          searchInput={searchInput} 
          setSearchInput={setSearchInput} 
          onSearch={handleSearch} 
          results={data?.searchResults} 
          onSelect={handleSelect} 
          selectedId={playerId} 
          placeholder="Search hitters..."
        />
        
        {query.isLoading ? (
          <div className="flex-1"><LoadingPanel rows={10} /></div>
        ) : query.isError ? (
          <div className="flex-1"><QueryMessage kind="error" onRetry={() => query.refetch()} /></div>
        ) : data?.profile ? (
          <LabProfile 
            profile={data.profile} 
            window={windowParam} 
            onWindowChange={handleWindowChange} 
            windows={['SEASON', 'CAREER', 'ROLLING_7', 'ROLLING_14', 'ROLLING_30', 'ROLLING_60']}
          />
        ) : (
          <div className="flex-1">
            <Panel className="h-full min-h-[400px] flex items-center justify-center border-dashed">
              <QueryMessage kind="empty" />
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}

function PitcherLabPage() {
  const [location, setLocation] = useLocation();
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const playerIdParam = params.get('playerId');
  const playerId = playerIdParam ? parseInt(playerIdParam, 10) : undefined;
  const search = params.get('search') || undefined;
  const windowParam = (params.get('window') || 'SEASON') as any;
  const dateParam = params.get('date') || undefined;

  const [searchInput, setSearchInput] = useState(search || '');

  const query = useGetAnalystPitcherLab({ playerId, search, window: windowParam, date: dateParam });
  const data = query.data;
  
  const refresh = useRefreshAnalystResearch();

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const newParams = new URLSearchParams(searchString);
    if (searchInput) newParams.set('search', searchInput);
    else newParams.delete('search');
    newParams.delete('playerId');
    setLocation(`${location}?${newParams.toString()}`);
  };

  const handleSelect = (id: number) => {
    const newParams = new URLSearchParams(searchString);
    newParams.set('playerId', id.toString());
    setLocation(`${location}?${newParams.toString()}`);
  };

  const handleWindowChange = (w: string) => {
    const newParams = new URLSearchParams(searchString);
    newParams.set('window', w);
    setLocation(`${location}?${newParams.toString()}`);
  };
  const handleDateChange = (date: string) => {
    const newParams = new URLSearchParams(searchString);
    if (date) newParams.set('date', date); else newParams.delete('date');
    setLocation(`${location}?${newParams.toString()}`);
  };

  return (
    <div className="page-content rise-in">
      <div className="page-intro">
        <div>
          <Kicker>Pitcher inspection</Kicker>
          <h1>Pitcher <span className="slash">//</span> lab</h1>
          <p>Canonical pitcher research profiles. Provenance-backed evidence, zero synthetic predictions.</p>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" className="search-input !h-[35px] !w-auto" value={dateParam || data?.profile?.effectiveTo.slice(0, 10) || ''} onChange={(e) => handleDateChange(e.target.value)} data-testid="input-pitcher-lab-date" />
          <button className="button button-dark" onClick={() => refresh.mutate({})} disabled={refresh.isPending} data-testid="button-refresh-research">
            <RefreshCw size={15} /> {refresh.isPending ? 'Ingesting...' : 'Sync statcast/fangraphs'}
          </button>
        </div>
      </div>

      <div className="lab-layout">
        <LabSearchPanel 
          searchInput={searchInput} 
          setSearchInput={setSearchInput} 
          onSearch={handleSearch} 
          results={data?.searchResults} 
          onSelect={handleSelect} 
          selectedId={playerId} 
          placeholder="Search pitchers..."
        />
        
        {query.isLoading ? (
          <div className="flex-1"><LoadingPanel rows={10} /></div>
        ) : query.isError ? (
          <div className="flex-1"><QueryMessage kind="error" onRetry={() => query.refetch()} /></div>
        ) : data?.profile ? (
          <LabProfile 
            profile={data.profile} 
            window={windowParam} 
            onWindowChange={handleWindowChange} 
            windows={['SEASON', 'CAREER', 'ROLLING_7', 'ROLLING_14', 'ROLLING_30', 'ROLLING_60']}
          />
        ) : (
          <div className="flex-1">
            <Panel className="h-full min-h-[400px] flex items-center justify-center border-dashed">
              <QueryMessage kind="empty" />
            </Panel>
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

function MarketBoardPage() {
  const [dateParam, setDateParam] = useState('');
  const [marketParam, setMarketParam] = useState<MarketShortCode | ''>('');
  const [gameIdParam, setGameIdParam] = useState('');

  const effectiveDate = dateParam || new Date().toISOString().slice(0, 10);
  const params = {
    date: effectiveDate,
    ...(marketParam ? { market: marketParam as MarketShortCode } : {}),
    ...(gameIdParam ? { gameId: gameIdParam } : {}),
  };

  const query = useGetAnalystMarketResearch(params);
  const data = query.data as MarketResearch | undefined;

  return (
    <div className="page-content rise-in">
      <div className="page-intro">
        <div>
          <Kicker>Market research / Phase 3</Kicker>
          <h1>Market <span className="slash">//</span> board</h1>
          <p>
            Four independent hitter markets: 2+ Total Bases, Extra Base Hit, Batter Walk, Home Run.
            Populated by engines 3A–3D. Empty until at least one engine has completed a research pass.
          </p>
        </div>
        <button
          className="button button-dark"
          onClick={() => query.refetch()}
          disabled={query.isLoading}
          data-testid="button-refresh-market-board"
        >
          <RefreshCw size={15} /> {query.isLoading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* Filters */}
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
          {(['TB', 'XBH', 'WALK', 'HR'] as MarketShortCode[]).map((m) => (
            <option key={m} value={m}>{MARKET_LABELS[m]}</option>
          ))}
        </select>
        <input
          type="text"
          className="search-input !h-[35px] !w-[120px]"
          value={gameIdParam}
          onChange={(e) => setGameIdParam(e.target.value.trim())}
          placeholder="Game ID"
          data-testid="input-market-board-gameid"
        />
      </div>

      {/* TB Engine panel */}
      <TBEnginePanel slateDate={effectiveDate} onComplete={() => query.refetch()} />

      {/* Contract banner — always visible */}
      <Panel className="mb-6 bg-accent/5 border-accent/20">
        <div className="p-4 space-y-3">
          <Kicker>Phase 3 contract</Kicker>
          {data && (
            <p className="text-xs font-mono text-muted-foreground" data-testid="rank-semantics">
              {data.rankSemantics}
            </p>
          )}
          <div className="flex flex-wrap gap-3 mt-3">
            {(['TB', 'XBH', 'WALK', 'HR'] as MarketShortCode[]).map((m) => (
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
          {data && (
            <div className="mt-2">
              <span className="text-xs text-muted-foreground">Prohibited fields (absent from contract): </span>
              <span className="font-mono text-xs text-muted-foreground" data-testid="prohibited-fields">
                {data.prohibitedFields.join(', ')}
              </span>
            </div>
          )}
        </div>
      </Panel>

      {/* Summary metrics */}
      {data && (
        <div className="metric-grid mb-6">
          <Metric label="Candidates" value={data.candidateCount} note={`${marketParam ? MARKET_LABELS[marketParam] : 'all markets'} · ${effectiveDate}`} tone="accent" />
          <Metric label="Market" value={marketParam ? MARKET_LABELS[marketParam] : 'All 4 markets'} note="TB / XBH / WALK / HR are independent" tone="neutral" />
          <Metric
            label="STRONG / POSITIVE"
            value={data.candidates.filter((c) => c.researchState === 'STRONG' || c.researchState === 'POSITIVE').length}
            note="Positive research state"
            tone={data.candidates.some((c) => c.researchState === 'STRONG' || c.researchState === 'POSITIVE') ? 'good' : 'neutral'}
          />
          <Metric
            label="BLOCKED"
            value={data.candidates.filter((c) => c.researchState === 'BLOCKED').length}
            note="Evidence structurally absent"
            tone={data.candidates.some((c) => c.researchState === 'BLOCKED') ? 'bad' : 'good'}
          />
        </div>
      )}

      {query.isLoading ? (
        <LoadingPanel rows={5} />
      ) : query.isError ? (
        <QueryMessage kind="error" onRetry={() => query.refetch()} />
      ) : !data || data.candidateCount === 0 ? (
        <Panel>
          <div className="p-8 text-center space-y-3">
            <Kicker>No candidates yet</Kicker>
            <h2 className="text-lg">Run an engine above or wait for engines 3A–3D</h2>
            <p className="text-sm text-muted-foreground max-w-lg mx-auto">
              Click "Run TB engine" above to populate 2+ Total Bases candidates for today's slate.
              Extra Base Hit (3B), Batter Walk (3C), and Home Run (3D) engines will appear here
              as they are built.
            </p>
            <div className="flex justify-center gap-2 mt-4">
              {(['TB', 'XBH', 'WALK', 'HR'] as MarketShortCode[]).map((m) => (
                <span key={m} className="badge badge-neutral font-mono text-xs" data-testid={`market-contract-badge-${m}`}>{m}</span>
              ))}
            </div>
            {data && (
              <p className="text-xs font-mono text-muted-foreground mt-3" data-testid="system-note">
                {data.systemNote}
              </p>
            )}
          </div>
        </Panel>
      ) : (
        <Panel>
          <SectionHeading
            eyebrow={`${data.candidateCount} candidates · ${effectiveDate}`}
            title="Research board"
            detail="Ordered by research_rank ASC (1 = highest). Ties share the same rank value. RANK_DONT_GATE — no state removes a candidate from the board."
          />
          <div className="table-wrap">
            <table className="data-table" data-testid="market-board-table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Player</th>
                  <th>Market</th>
                  <th>State</th>
                  <th>Mechanism</th>
                  <th>Slot</th>
                  <th>Pitcher xSLG alw</th>
                  <th>Counter flags</th>
                  <th>Missing/Stale</th>
                </tr>
              </thead>
              <tbody>
                {data.candidates.map((c, i) => (
                  <CandidateRow key={c.candidateId} candidate={c} index={i} />
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
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

function Router() {
  return (
    <AppShell>
      <ErrorBoundary resetKey={window.location.pathname}>
        <Switch>
          <Route path="/" component={DashboardPage} />
          <Route path="/projection-center" component={ProjectionsPage} />
          <Route path="/data-health" component={DataHealthPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route path="/game-lab" component={GameLabPage} />
          <Route path="/player-lab" component={PlayerLabPage} />
          <Route path="/pitcher-lab" component={PitcherLabPage} />
          <Route path="/bullpen-room" component={BullpenRoomPage} />
          <Route path="/market-board" component={MarketBoardPage} />
          <Route path="/bettor-intelligence">{() => <FuturePage label="Bettor intelligence" />}</Route>
          <Route path="/model-lab">{() => <FuturePage label="Model lab" />}</Route>
          <Route path="/ai-analyst">{() => <FuturePage label="AI analyst" />}</Route>
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