import { type ReactNode, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useGetAnalystDataHealth, useGetAnalystProjections, useGetAnalystSettings, useGetAnalystToday, useRefreshFantasyPros, useRefreshMlbOfficial, useGetAnalystPlayerLab, useGetAnalystPitcherLab, useGetAnalystGameLab, useRefreshAnalystResearch } from '@workspace/api-client-react';
import type { AnalystSettings, DataHealth, HealthIssue, ProjectionCenter, ProjectionRow, SlateGame, SourceBadge, TodayDashboard, ResearchMetric, ResearchSearchResult, ResearchProfile } from '@workspace/api-client-react';
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
      { href: '/bullpen-room', label: 'Bullpen room', icon: ShieldCheck, future: true },
      { href: '/bettor-intelligence', label: 'Bettor intelligence', icon: BarChart3, future: true },
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
              <Metric label="Hitter profiles" value={data.researchHealth?.playerProfiles ?? 0} note="Searchable hitter states" tone="good" />
              <Metric label="Pitcher profiles" value={data.researchHealth?.pitcherProfiles ?? 0} note="Searchable pitcher states" tone="good" />
              <Metric label="Park contexts" value={data.researchHealth?.parkProfiles ?? 0} note="Available venue spans" tone="good" />
              <Metric label="Stale windows" value={data.researchHealth?.staleWindows ?? 0} note="Requires refresh" tone={(data.researchHealth?.staleWindows ?? 0) > 0 ? 'warn' : 'good'} />
              <Metric label="Quarantined records" value={data.researchHealth?.identityQuarantines ?? 0} note="ID mapping failed" tone={(data.researchHealth?.identityQuarantines ?? 0) > 0 ? 'bad' : 'good'} />
              <Metric label="Insufficient samples" value={data.researchHealth?.insufficientSamples ?? 0} note="Statistically suppressed" tone={(data.researchHealth?.insufficientSamples ?? 0) > 0 ? 'warn' : 'good'} />
              <Metric label="Missing splits" value={data.researchHealth?.missingHandednessSplits ?? 0} note="Handedness context lost" tone={(data.researchHealth?.missingHandednessSplits ?? 0) > 0 ? 'bad' : 'good'} />
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
          <Route path="/bullpen-room">{() => <FuturePage label="Bullpen room" />}</Route>
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