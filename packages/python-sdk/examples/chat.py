from x402_sdk import X402Client


client = X402Client(
    gateway_url="https://gateway.example.com",
    secret_key="S...",
    network="testnet",
)

result = client.call(
    {
        "model": "gpt-4",
        "messages": [{"role": "user", "content": "Explain x402 in one sentence."}],
    }
)

print(result)

