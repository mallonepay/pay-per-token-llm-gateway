# x402 Python SDK

Python client for the x402 LLM Gateway. It mirrors the TypeScript SDK flow:

1. Send an OpenAI-compatible chat request.
2. Parse `402 Payment Required` quotes.
3. Build and submit a Stellar payment.
4. Poll Horizon for confirmation.
5. Retry the request with `X-Payment-Hash`.

It also includes an optional LangChain-compatible chat model wrapper.

## Install

```bash
pip install x402-sdk
pip install "x402-sdk[langchain]"
```

## Basic Usage

```python
from x402_sdk import X402Client

client = X402Client(
    gateway_url="https://gateway.example.com",
    secret_key="S...",
    network="testnet",
)

result = client.call({
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello"}],
})

print(result["response"]["choices"][0]["message"]["content"])
```

## Streaming

```python
for chunk in client.call_stream({
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Stream this"}],
}):
    print(chunk)
```

## External Signer

Use `public_key` and `sign_transaction` when a browser wallet, hardware wallet,
or agent wallet signs the unsigned XDR.

```python
client = X402Client(
    gateway_url="https://gateway.example.com",
    public_key="G...",
    sign_transaction=lambda unsigned_xdr: wallet.sign(unsigned_xdr),
)
```

## LangChain

```python
from x402_sdk.langchain import ChatX402

llm = ChatX402(
    gateway_url="https://gateway.example.com",
    secret_key="S...",
    model="gpt-4",
)

response = llm.invoke("Hello")
print(response.content)
```

## Notes

- Quote amounts are represented in the gateway's smallest unit. Stellar
  transactions require decimal asset units, so the SDK converts `1e-7` units
  before building a payment.
- Per-token routes work the same as flat routes from the client side: the
  quote amount is the deposit, and final cost is returned by the gateway in
  the payment receipt headers or stream trailer.

