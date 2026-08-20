import { type ReactNode, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useGetAnalystDataHealth, useGetAnalystProjections, useGetAnalystSettings, useGetAnalystToday, useRefreshFantasyPros, useRefreshMlbOfficial } from '@workspace/api-client-react';
import type { AnalystSettings, DataHealth, HealthIssue, ProjectionCenter, ProjectionRow, SlateGame, SourceBadge, TodayDashboard } from '@workspace/api-client-react';
import { Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3, Bell, BookOpen, CalendarDays, Check, ChevronRight, Cloud, Database, Gauge, GitBranch, Home, LineChart, LockKeyhole, Menu, RefreshCw, Server, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Table2, Target, X } from 'lucide-react';
import { Link, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
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
      { href: '/game-lab', label: 'Game lab', icon: CalendarDays, future: true },
      { href: '/player-lab', label: 'Player lab', icon: Target, future: true },
      { href: '/pitcher-lab', label: 'Pitcher lab', icon: Activity, future: true },
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
            <div className="snapshot-times"><div><span>Current as of</span><strong>{data.currentAsOf}</strong></div><div><span>Prior as of</span><strong>{data.priorAsOf ?? 'Not available'}</strong></div></div>
            <Badge tone="good"><StatusDot tone="good" /> Reproducible view</Badge>
          </Panel>
          <Panel className="projection-panel">
            <SectionHeading eyebrow="Player source components" title="Four-market foundation" detail={`${data.rows?.length ?? 0} rows / source components only`} action={<button className="icon-button" onClick={() => refreshFantasyPros.mutate({})} disabled={refreshFantasyPros.isPending} aria-label="Ingest FantasyPros projection table" data-testid="button-refresh-projection-table"><RefreshCw size={15} /></button>} />
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

function Router() {
  return (
    <AppShell>
      <ErrorBoundary resetKey={window.location.pathname}>
        <Switch>
          <Route path="/" component={DashboardPage} />
          <Route path="/projection-center" component={ProjectionsPage} />
          <Route path="/data-health" component={DataHealthPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route path="/game-lab">{() => <FuturePage label="Game lab" />}</Route>
          <Route path="/player-lab">{() => <FuturePage label="Player lab" />}</Route>
          <Route path="/pitcher-lab">{() => <FuturePage label="Pitcher lab" />}</Route>
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