// Kill switch: when a budget notification says cost >= budget, disable billing on the project.
// Based on Google's "cap costs by disabling billing" pattern. A billing-disabled project stops all
// paid resources (the Cloud Run service goes offline) until billing is re-enabled by hand.
// Invoked by an authenticated Pub/Sub push subscription on the `billing-alerts` topic.
const functions = require("@google-cloud/functions-framework");
const { CloudBillingClient } = require("@google-cloud/billing");

const PROJECT_ID = process.env.GCP_PROJECT || "fantasy-mcp";
const DRY_RUN = process.env.DRY_RUN === "1";
const billing = new CloudBillingClient();

functions.http("billingGuard", async (req, res) => {
  try {
    const raw = req.body?.message?.data;
    if (!raw) {
      console.log("no message data, ignoring");
      return res.status(204).send();
    }
    const note = JSON.parse(Buffer.from(raw, "base64").toString());
    const { costAmount, budgetAmount, budgetDisplayName } = note;
    console.log(`budget "${budgetDisplayName}": cost=${costAmount} budget=${budgetAmount}`);

    if (typeof costAmount !== "number" || typeof budgetAmount !== "number" || costAmount < budgetAmount) {
      console.log("under budget, nothing to do");
      return res.status(204).send();
    }
    const name = `projects/${PROJECT_ID}`;
    const [info] = await billing.getProjectBillingInfo({ name });
    if (!info.billingEnabled) {
      console.log("billing already disabled");
      return res.status(204).send();
    }
    if (DRY_RUN) {
      console.log(`DRY RUN: would disable billing on ${PROJECT_ID}`);
      return res.status(204).send();
    }
    await billing.updateProjectBillingInfo({ name, projectBillingInfo: { billingAccountName: "" } });
    console.log(`BILLING DISABLED on ${PROJECT_ID}`);
    res.status(204).send();
  } catch (err) {
    console.error("billing-guard error", err);
    res.status(500).send(); // Pub/Sub will retry
  }
});
