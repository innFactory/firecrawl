// Import necessary dependencies and types
import { AuthCreditUsageChunk } from "../../controllers/v1/types";
import { clearACUC, clearACUCTeam, getACUC } from "../../controllers/auth";
import { redlock } from "../redlock";
import { supabase_rr_service, supabase_service } from "../supabase";
import {
  createPaymentIntent,
  createSubscription,
  customerToUserId,
} from "./stripe";
import { issueCredits } from "./issue_credits";
import {
  sendNotification,
  sendNotificationWithCustomDays,
} from "../notification/email_notification";
import { NotificationType } from "../../types";
import { redisRateLimitClient } from "../rate-limiter";
import { sendSlackWebhook } from "../alerts/slack";
import { logger as _logger } from "../../lib/logger";

/**
 * Attempt to automatically charge a user's account when their credit balance falls below a threshold
 * @param chunk The user's current usage data
 * @param autoRechargeThreshold The credit threshold that triggers auto-recharge
 */
export async function autoCharge(
  chunk: AuthCreditUsageChunk,
  autoRechargeThreshold: number,
): Promise<{
  success: boolean;
  message: string;
  remainingCredits: number;
  chunk: AuthCreditUsageChunk;
}> {
  if (chunk.price_associated_auto_recharge_price_id !== null) {
    return _autoChargeScale(
      chunk as AuthCreditUsageChunk & {
        price_associated_auto_recharge_price_id: string;
      },
      autoRechargeThreshold,
    );
  } else {
    const logger = _logger.child({
      module: "auto_charge",
      method: "autoCharge",
      team_id: chunk.team_id,
      teamId: chunk.team_id,
    });
    logger.error("No price associated auto-recharge price id found", {});
    return {
      success: false,
      message: "No price associated auto-recharge price id found",
      remainingCredits: chunk.remaining_credits,
      chunk,
    };
  }
}

async function _autoChargeScale(
  chunk: AuthCreditUsageChunk & {
    price_associated_auto_recharge_price_id: string;
  },
  autoRechargeThreshold: number,
): Promise<{
  success: boolean;
  message: string;
  remainingCredits: number;
  chunk: AuthCreditUsageChunk;
}> {
  const logger = _logger.child({
    module: "auto_charge",
    method: "_autoChargeScale",
    team_id: chunk.team_id,
    teamId: chunk.team_id,
  });

  logger.info("Scale auto-recharge triggered", {});

  const resource = `auto-recharge:${chunk.team_id}`;

  try {
    return await redlock.using([resource], 15000, async signal => {
      logger.info("Lock acquired");
      const updatedChunk = await getACUC(chunk.api_key, false, false);

      if (
        updatedChunk &&
        updatedChunk.remaining_credits < autoRechargeThreshold
      ) {
        // Check for recharges this month

        const currentMonth = new Date();
        currentMonth.setUTCDate(1);
        currentMonth.setUTCHours(0, 0, 0, 0);

        const { data: rechargesThisMonth, error: rechargesThisMonthError } =
          await supabase_service
            .from("subscriptions")
            .select("*")
            .eq("team_id", chunk.team_id)
            .eq("metadata->>auto_recharge", "true")
            .gte("current_period_start", currentMonth.toISOString());

        if (rechargesThisMonthError || !rechargesThisMonth) {
          logger.error("Error fetching recharges this month", {
            error: rechargesThisMonthError,
          });
          return {
            success: false,
            message: "Error fetching recharges this month",
            remainingCredits:
              updatedChunk?.remaining_credits ?? chunk.remaining_credits,
            chunk: updatedChunk ?? chunk,
          };
        } else if (rechargesThisMonth.length >= 4) {
          logger.warn("Auto-recharge failed: too many recharges this month");
          return {
            success: false,
            message: "Auto-recharge failed: too many recharges this month",
            remainingCredits:
              updatedChunk?.remaining_credits ?? chunk.remaining_credits,
            chunk: updatedChunk ?? chunk,
          };
        } else {
          // Actually re-charge

          const { data: price, error: priceError } = await supabase_service
            .from("prices")
            .select("*")
            .eq("id", chunk.price_associated_auto_recharge_price_id)
            .single();
          if (priceError || !price) {
            logger.error("Error fetching price", {
              error: priceError,
              priceId:
                chunk.price_associated_auto_recharge_price_id === undefined
                  ? "undefined"
                  : JSON.stringify(
                    chunk.price_associated_auto_recharge_price_id,
                  ),
            });
            return {
              success: false,
              message: "Error fetching price",
              remainingCredits:
                updatedChunk?.remaining_credits ?? chunk.remaining_credits,
              chunk: updatedChunk ?? chunk,
            };
          }

          if (!chunk.sub_user_id) {
            logger.error("No sub_user_id found in chunk");
            return {
              success: false,
              message: "No sub_user_id found in chunk",
              remainingCredits:
                updatedChunk?.remaining_credits ?? chunk.remaining_credits,
              chunk: updatedChunk ?? chunk,
            };
          }

          const { data: customer, error: customersError } =
            await supabase_rr_service
              .from("customers")
              .select("id, stripe_customer_id")
              .eq("id", chunk.sub_user_id)
              .single();

          if (customersError || !customer) {
            logger.error("Error fetching customer data", {
              error: customersError,
            });
            return {
              success: false,
              message: "Error fetching customer data",
              remainingCredits:
                updatedChunk?.remaining_credits ?? chunk.remaining_credits,
              chunk: updatedChunk ?? chunk,
            };
          }

          if (!customer.stripe_customer_id) {
            logger.error("No stripe_customer_id found in customer");
            return {
              success: false,
              message: "No stripe_customer_id found in customer",
              remainingCredits:
                updatedChunk?.remaining_credits ?? chunk.remaining_credits,
              chunk: updatedChunk ?? chunk,
            };
          }

          if (!chunk.sub_id) {
            logger.error("No sub_id found in chunk");
            return {
              success: false,
              message: "No sub_id found in chunk",
              remainingCredits:
                updatedChunk?.remaining_credits ?? chunk.remaining_credits,
              chunk: updatedChunk ?? chunk,
            };
          }

          const subscription = await createSubscription(
            chunk.team_id,
            customer.stripe_customer_id,
            chunk.price_associated_auto_recharge_price_id,
            chunk.sub_id,
          );
          if (!subscription) {
            logger.error("Failed to create subscription");
            return {
              success: false,
              message: "Failed to create subscription",
              remainingCredits:
                updatedChunk?.remaining_credits ?? chunk.remaining_credits,
              chunk: updatedChunk ?? chunk,
            };
          }

          const userId = await customerToUserId(customer.stripe_customer_id);
          if (!userId) {
            logger.error("Failed to get user id from customer");
            return {
              success: false,
              message: "Failed to get user id from customer",
              remainingCredits:
                updatedChunk?.remaining_credits ?? chunk.remaining_credits,
              chunk: updatedChunk ?? chunk,
            };
          }

          // Try to insert it into subscriptions ourselves in case webhook is slow
          const { error: subscriptionError } = await supabase_service
            .from("subscriptions")
            .insert({
              id: subscription.id,
              user_id: userId,
              metadata: subscription.metadata,
              status: subscription.status,
              price_id: chunk.price_associated_auto_recharge_price_id,
              quantity: 1,
              cancel_at_period_end: false,
              cancel_at: null,
              canceled_at: null,
              current_period_start: subscription.current_period_start
                ? new Date(
                  subscription.current_period_start * 1000,
                ).toISOString()
                : null,
              current_period_end: subscription.current_period_end
                ? new Date(subscription.current_period_end * 1000).toISOString()
                : null,
              created: subscription.created
                ? new Date(subscription.created * 1000).toISOString()
                : null,
              ended_at: null,
              trial_start: null,
              trial_end: null,
              team_id: chunk.team_id,
              is_extract: false,
            });

          if (subscriptionError) {
            logger.warn(
              "Failed to add subscription to supabase -- maybe we got sniped by the webhook?",
              { error: subscriptionError },
            );
          }

          // Reset ACUC cache to reflect the new credit balance
          await clearACUC(chunk.api_key);
          await clearACUCTeam(chunk.team_id);

          try {
            // Check for frequent auto-recharges in the past week
            const weeklyAutoRechargeKey = `auto-recharge-weekly:${chunk.team_id}`;
            const weeklyRecharges = await redisRateLimitClient.incr(
              weeklyAutoRechargeKey,
            );
            // Set expiry for 7 days if not already set
            await redisRateLimitClient.expire(
              weeklyAutoRechargeKey,
              7 * 24 * 60 * 60,
            );

            // If this is the second auto-recharge in a week, send notification
            if (weeklyRecharges >= 2) {
              await sendNotificationWithCustomDays(
                chunk.team_id,
                NotificationType.AUTO_RECHARGE_FREQUENT,
                7, // Send at most once per week
                false,
              );
            }
          } catch (error) {
            logger.error(`Error sending frequent auto-recharge notification`, {
              error,
            });
          }

          await sendNotification(
            chunk.team_id,
            NotificationType.AUTO_RECHARGE_SUCCESS,
            chunk.sub_current_period_start,
            chunk.sub_current_period_end,
            chunk,
            true,
          );

          logger.info("Scale auto-recharge successful");

          if (process.env.SLACK_ADMIN_WEBHOOK_URL) {
            sendSlackWebhook(
              `💰 Auto-recharge successful on team ${chunk.team_id} for ${price.credits} credits (total auto-recharges this month: ${rechargesThisMonth.length + 1}).`,
              false,
              process.env.SLACK_ADMIN_WEBHOOK_URL,
            ).catch(error => {
              logger.debug(
                `Error sending slack notification: ${error}`,
              );
            });
          }

          return {
            success: true,
            message: "Auto-recharge successful",
            remainingCredits:
              (updatedChunk?.remaining_credits ?? chunk.remaining_credits) +
              price.credits,
            chunk: {
              ...(updatedChunk ?? chunk),
              remaining_credits:
                (updatedChunk?.remaining_credits ?? chunk.remaining_credits) +
                price.credits,
            },
          };
        }
      } else {
        return {
          success: false,
          message: "No need to auto-recharge",
          remainingCredits:
            updatedChunk?.remaining_credits ?? chunk.remaining_credits,
          chunk: updatedChunk ?? chunk,
        };
      }
    });
  } catch (error) {
    logger.error("Auto-recharge failed", { error });
    return {
      success: false,
      message: "Failed to acquire lock for auto-recharge",
      remainingCredits: chunk.remaining_credits,
      chunk,
    };
  }
}
