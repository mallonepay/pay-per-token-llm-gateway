export const config = {
  escrowSettlementEnabled: process.env.ESCROW_SETTLEMENT_ENABLED === 'true',
  payoutAutomationEnabled: process.env.PAYOUT_AUTOMATION_ENABLED === 'true',
  contractAdminSecret: process.env.CONTRACT_ADMIN_SECRET,
  //... other config
};
