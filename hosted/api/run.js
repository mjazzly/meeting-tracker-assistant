// One run: Vercel Cron at 7:00 to 7:59 AM Kuala Lumpur, or Megat with RUN_TOKEN (see lib/app.js).
import { adapt } from "../lib/deps.js";
import { runRoute } from "../lib/app.js";

export default adapt(runRoute);
