export interface PaymentRequest {
  amount: string;
  asset: string;
  destination: string;
  memo?: string;
}

export interface PaymentResult {
  success: boolean;
  transactionHash?: string;
  error?: string;
}

export interface X402ClientConfig {
  horizonUrl: string;
  secretKey?: string;
  signTransaction?: (txXdr: string) => Promise<string>;
}