import { useCallback, useEffect, useState } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { getAppConfig, type AppConfig } from "@/lib/api";
import { DraftLegalBanner, FulfillmentBanner, Masthead, PilotBanner, TabBar } from "@/components/Chrome";
import Landing from "@/pages/Landing";
import SignIn from "@/pages/SignIn";
import RiderDashboard from "@/pages/RiderDashboard";
import RequestWizard from "@/pages/RequestWizard";
import RideDetail from "@/pages/RideDetail";
import DriverApply from "@/pages/DriverApply";
import DriverHome from "@/pages/DriverHome";
import DriverCredentials from "@/pages/DriverCredentials";
import DriverVehicles from "@/pages/DriverVehicles";
import DriverAvailability from "@/pages/DriverAvailability";
import DriverActiveRide from "@/pages/DriverActiveRide";
import IncidentReport from "@/pages/IncidentReport";
import IncidentCenter from "@/pages/IncidentCenter";
import OrgDashboard from "@/pages/OrgDashboard";
import MyAuthorizations from "@/pages/MyAuthorizations";
import Contributions from "@/pages/Contributions";
import Reports from "@/pages/Reports";
import DispatchBoard from "@/pages/DispatchBoard";
import AdminSettings from "@/pages/AdminSettings";
import Resources from "@/pages/Resources";
import Policies from "@/pages/Policies";
import Support from "@/pages/Support";

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const location = useLocation();

  const reload = useCallback(() => {
    getAppConfig().then((c) => setConfig(c as AppConfig)).catch(() => setConfig(null));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Move focus to the page heading on navigation, so screen-reader and keyboard
  // users are not left at the bottom of the previous page.
  useEffect(() => {
    document.getElementById("main")?.focus();
  }, [location.pathname]);

  const roles = config?.roles?.roles ?? [];
  const showPolicyBanner = location.pathname.startsWith("/policies");

  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to the main content</a>
      <Masthead config={config} />
      <PilotBanner config={config} />
      <FulfillmentBanner config={config} />
      {showPolicyBanner && <DraftLegalBanner config={config} />}

      <Routes>
        <Route path="/" element={<Landing config={config} />} />
        <Route path="/signin" element={<SignIn />} />
        <Route path="/rides" element={<RiderDashboard config={config} />} />
        <Route path="/rides/new" element={<RequestWizard config={config} />} />
        <Route path="/rides/:rideId" element={<RideDetail config={config} />} />
        <Route path="/driver" element={<DriverHome />} />
        <Route path="/driver/apply" element={<DriverApply config={config} />} />
        <Route path="/driver/credentials" element={<DriverCredentials />} />
        <Route path="/driver/car" element={<DriverVehicles />} />
        <Route path="/driver/times" element={<DriverAvailability />} />
        <Route path="/driver/rides/:rideId" element={<DriverActiveRide config={config} />} />
        <Route path="/incident/new" element={<IncidentReport config={config} />} />
        <Route path="/safety" element={<IncidentCenter />} />
        <Route path="/org" element={<OrgDashboard config={config} />} />
        <Route path="/org/contributions" element={<Contributions config={config} />} />
        <Route path="/permissions" element={<MyAuthorizations />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/dispatch" element={<DispatchBoard />} />
        <Route path="/admin" element={<AdminSettings config={config} reload={reload} />} />
        <Route path="/resources" element={<Resources />} />
        <Route path="/policies" element={<Policies config={config} />} />
        <Route path="/support" element={<Support config={config} />} />
        <Route path="*" element={<main id="main" className="pad"><h1>That page does not exist</h1><p>Check the address, or use the menu at the bottom of the screen.</p></main>} />
      </Routes>

      <TabBar roles={roles} />
    </div>
  );
}
