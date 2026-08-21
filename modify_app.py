import re

with open('artifacts/mlb-analyst/src/App.tsx', 'r') as f:
    content = f.read()

# 1. Imports
content = content.replace(
    "import { useGetAnalystDataHealth, useGetAnalystProjections, useGetAnalystSettings, useGetAnalystToday, useRefreshFantasyPros, useRefreshMlbOfficial } from '@workspace/api-client-react';",
    "import { useGetAnalystDataHealth, useGetAnalystProjections, useGetAnalystSettings, useGetAnalystToday, useRefreshFantasyPros, useRefreshMlbOfficial, useGetAnalystPlayerLab, useGetAnalystPitcherLab, useGetAnalystGameLab, useRefreshAnalystResearch } from '@workspace/api-client-react';"
)
content = content.replace(
    "import type { AnalystSettings, DataHealth, HealthIssue, ProjectionCenter, ProjectionRow, SlateGame, SourceBadge, TodayDashboard } from '@workspace/api-client-react';",
    "import type { AnalystSettings, DataHealth, HealthIssue, ProjectionCenter, ProjectionRow, SlateGame, SourceBadge, TodayDashboard, ResearchMetric, ResearchSearchResult, ResearchProfile } from '@workspace/api-client-react';"
)
content = content.replace(
    "import { Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3, Bell, BookOpen, CalendarDays, Check, ChevronRight, Cloud, Database, Gauge, GitBranch, Home, LineChart, LockKeyhole, Menu, RefreshCw, Server, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Table2, Target, X } from 'lucide-react';",
    "import { Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3, Bell, BookOpen, CalendarDays, Check, ChevronRight, Cloud, Database, Gauge, GitBranch, Home, LineChart, LockKeyhole, Menu, RefreshCw, Server, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Table2, Target, X, Search, ArrowRight } from 'lucide-react';"
)
content = content.replace(
    "import { Link, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';",
    "import { Link, Route, Switch, useLocation, useSearch, Router as WouterRouter } from 'wouter';"
)

# 2. Nav Groups
nav_original = """    items: [
      { href: '/game-lab', label: 'Game lab', icon: CalendarDays, future: true },
      { href: '/player-lab', label: 'Player lab', icon: Target, future: true },
      { href: '/pitcher-lab', label: 'Pitcher lab', icon: Activity, future: true },"""
nav_new = """    items: [
      { href: '/game-lab', label: 'Game lab', icon: CalendarDays },
      { href: '/player-lab', label: 'Player lab', icon: Target },
      { href: '/pitcher-lab', label: 'Pitcher lab', icon: Activity },"""
content = content.replace(nav_original, nav_new)

# 3. DataHealthPage replacements
metric_original = """<Metric label="Posted lineups" value={`${coverage?.officialLineupPlayersMapped ?? 0}/${coverage?.officialLineupPlayersTotal ?? 0}`} note="Official lineup players" tone={(coverage?.officialLineupPlayersMapped ?? 0) === (coverage?.officialLineupPlayersTotal ?? 0) ? 'good' : 'bad'} />"""
metric_new = """<Metric label="Posted lineups" value={(coverage?.officialLineupPlayersTotal ?? 0) === 0 ? 'N/A' : `${coverage?.officialLineupPlayersMapped ?? 0}/${coverage?.officialLineupPlayersTotal ?? 0}`} note={(coverage?.officialLineupPlayersTotal ?? 0) === 0 ? 'NO OFFICIAL LINEUPS POSTED' : 'Official lineup players'} tone={(coverage?.officialLineupPlayersTotal ?? 0) === 0 ? 'neutral' : (coverage?.officialLineupPlayersMapped ?? 0) === (coverage?.officialLineupPlayersTotal ?? 0) ? 'good' : 'bad'} />"""
content = content.replace(metric_original, metric_new)

panel_insert_point = """              <Metric label="Team conflicts" value={coverage?.teamAssignmentConflicts ?? 0} note="Source team vs official org" tone={(coverage?.teamAssignmentConflicts ?? 0) ? 'warn' : 'good'} />
            </div>
          </Panel>
          <div className="health-layout">"""
panel_new = """              <Metric label="Team conflicts" value={coverage?.teamAssignmentConflicts ?? 0} note="Source team vs official org" tone={(coverage?.teamAssignmentConflicts ?? 0) ? 'warn' : 'good'} />
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
          <div className="health-layout">"""
content = content.replace(panel_insert_point, panel_new)

# 4. Add new components before Router
new_components = """
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
              {panel.metrics.map(m => <MetricCard key={m.key} metric={m} />)}
            </div>
          </div>
        ))}
        {profile.arsenal.length > 0 && (
          <div className="metric-panel" data-testid="panel-arsenal">
            <h3>Observed Arsenal</h3>
            <div className="metric-grid-cards">
              {profile.arsenal.map(m => <MetricCard key={m.key} metric={m} />)}
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

  const [searchInput, setSearchInput] = useState(search || '');

  const query = useGetAnalystPlayerLab({ playerId, search, window: windowParam });
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

  return (
    <div className="page-content rise-in">
      <div className="page-intro">
        <div>
          <Kicker>Hitter inspection</Kicker>
          <h1>Player <span className="slash">//</span> lab</h1>
          <p>Canonical hitter research profiles. Provenance-backed evidence, zero synthetic predictions.</p>
        </div>
        <button className="button button-dark" onClick={() => refresh.mutate({})} disabled={refresh.isPending} data-testid="button-refresh-research">
          <RefreshCw size={15} /> {refresh.isPending ? 'Ingesting...' : 'Sync statcast/fangraphs'}
        </button>
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

  const [searchInput, setSearchInput] = useState(search || '');

  const query = useGetAnalystPitcherLab({ playerId, search, window: windowParam });
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

  return (
    <div className="page-content rise-in">
      <div className="page-intro">
        <div>
          <Kicker>Pitcher inspection</Kicker>
          <h1>Pitcher <span className="slash">//</span> lab</h1>
          <p>Canonical pitcher research profiles. Provenance-backed evidence, zero synthetic predictions.</p>
        </div>
        <button className="button button-dark" onClick={() => refresh.mutate({})} disabled={refresh.isPending} data-testid="button-refresh-research">
          <RefreshCw size={15} /> {refresh.isPending ? 'Ingesting...' : 'Sync statcast/fangraphs'}
        </button>
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

function Router() {"""
content = content.replace("function Router() {", new_components)

router_original = """          <Route path="/game-lab">{() => <FuturePage label="Game lab" />}</Route>
          <Route path="/player-lab">{() => <FuturePage label="Player lab" />}</Route>
          <Route path="/pitcher-lab">{() => <FuturePage label="Pitcher lab" />}</Route>"""
router_new = """          <Route path="/game-lab" component={GameLabPage} />
          <Route path="/player-lab" component={PlayerLabPage} />
          <Route path="/pitcher-lab" component={PitcherLabPage} />"""
content = content.replace(router_original, router_new)

with open('artifacts/mlb-analyst/src/App.tsx', 'w') as f:
    f.write(content)

