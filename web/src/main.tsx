import "./styles/app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Shell } from "./components/Shell";
import { ErrorNote, Spinner } from "./components/bits";
import { AuthProvider } from "./lib/auth";
import { commish } from "./lib/near";
import { How } from "./routes/How";
import { Join } from "./routes/Join";
import { Landing } from "./routes/Landing";
import { LeaguePage } from "./routes/LeaguePage";
import { NewLeague } from "./routes/New";
import { ReceiptPage } from "./routes/ReceiptPage";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 2, refetchOnWindowFocus: true } } });

function LeagueRoute() {
  const { leagueId } = useParams();
  const id = Number(leagueId);
  if (!Number.isInteger(id) || id < 0) return <Navigate to="/" replace />;
  return <LeaguePage leagueId={id} />;
}

/** /demo: the newest demo league the demo admin created (SPEC 5.8). */
function Demo() {
  const q = useQuery({ queryKey: ["demo-league"], queryFn: commish.latestDemo, staleTime: 60_000 });
  if (q.isLoading) return <Spinner label="Finding the demo league" />;
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <p className="py-8 text-muted">The demo league isn't set up yet.</p>;
  return <LeaguePage leagueId={q.data.id} demo />;
}

function NotFound() {
  return (
    <div className="py-10">
      <h1 className="display text-4xl">Nothing here</h1>
      <p className="mt-2 text-muted">That page doesn't exist.</p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Shell>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/new" element={<NewLeague />} />
              <Route path="/join/:leagueId" element={<Join />} />
              <Route path="/l/:leagueId" element={<LeagueRoute />} />
              <Route path="/l/:leagueId/r/:settlementId" element={<ReceiptPage />} />
              <Route path="/how" element={<How />} />
              <Route path="/demo" element={<Demo />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Shell>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
