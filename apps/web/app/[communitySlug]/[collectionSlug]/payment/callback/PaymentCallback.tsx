"use client";

import { useEffect, useState } from "react";
import { verifyPaymentAction } from "./actions.ts";

export function PaymentCallback({ reference }: { reference: string | null }) {
  const [status, setStatus] = useState<"verifying" | "completed" | "failed" | "review" | "error">("verifying");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!reference) {
      setStatus("error");
      setMessage("No payment reference found.");
      return;
    }

    verifyPaymentAction(reference).then((result) => {
      switch (result.outcome) {
        case "completed":
          setStatus("completed");
          setMessage("Your payment was successful. Thank you!");
          break;
        case "needs_review":
          setStatus("review");
          setMessage("Your payment is being reviewed. You will be notified once it is confirmed.");
          break;
        case "pending":
          setStatus("review");
          setMessage("Your payment is still being processed. Please check back shortly.");
          break;
        case "failed":
          setStatus("failed");
          setMessage("Your payment was not successful. Please try again.");
          break;
        case "not_found":
          setStatus("error");
          setMessage("This payment could not be found.");
          break;
        case "provider_unavailable":
          setStatus("review");
          setMessage("We could not verify your payment right now. It will be checked automatically.");
          break;
        case "error":
          setStatus("review");
          setMessage("We could not confirm your payment yet. If money left your account, it is safe and will be checked.");
          break;
      }
    }).catch(() => {
      setStatus("error");
      setMessage("Something went wrong while verifying your payment. Please contact the organiser.");
    });
  }, [reference]);

  return (
    <div style={{ maxWidth: 480, margin: "80px auto", padding: 24, textAlign: "center" }}>
      {status === "verifying" && <p>Verifying your payment...</p>}
      {status === "completed" && (
        <div>
          <h2>Payment Successful</h2>
          <p>{message}</p>
        </div>
      )}
      {status === "failed" && (
        <div>
          <h2>Payment Failed</h2>
          <p>{message}</p>
        </div>
      )}
      {status === "review" && (
        <div>
          <h2>Payment Under Review</h2>
          <p>{message}</p>
        </div>
      )}
      {status === "error" && (
        <div>
          <h2>Error</h2>
          <p>{message}</p>
        </div>
      )}
    </div>
  );
}
