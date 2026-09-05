from __future__ import annotations

from typing import Any, Dict, List, Optional

from .client import X402Client

try:
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
    from langchain_core.outputs import ChatGeneration, ChatResult
except Exception:  # pragma: no cover - optional dependency
    BaseChatModel = object  # type: ignore
    AIMessage = BaseMessage = HumanMessage = SystemMessage = None  # type: ignore
    ChatGeneration = ChatResult = None  # type: ignore


def _message_to_dict(message: Any) -> Dict[str, str]:
    if SystemMessage is not None and isinstance(message, SystemMessage):
        role = "system"
    elif AIMessage is not None and isinstance(message, AIMessage):
        role = "assistant"
    else:
        role = "user"
    return {"role": role, "content": str(message.content)}


class ChatX402(BaseChatModel):  # type: ignore[misc,valid-type]
    client: X402Client
    model: str
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    path: str = "/v1/chat/completions"

    def __init__(
        self,
        *,
        gateway_url: str,
        model: str,
        secret_key: Optional[str] = None,
        public_key: Optional[str] = None,
        sign_transaction=None,
        network: str = "testnet",
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        path: str = "/v1/chat/completions",
        **kwargs: Any,
    ) -> None:
        if BaseChatModel is object:
            raise ImportError('Install LangChain support with: pip install "x402-sdk[langchain]"')
        super().__init__(**kwargs)
        self.client = X402Client(
            gateway_url=gateway_url,
            secret_key=secret_key,
            public_key=public_key,
            sign_transaction=sign_transaction,
            network=network,  # type: ignore[arg-type]
        )
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.path = path

    @property
    def _llm_type(self) -> str:
        return "x402-chat"

    def _generate(
        self,
        messages: List[Any],
        stop: Optional[List[str]] = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> Any:
        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": [_message_to_dict(message) for message in messages],
            **kwargs,
        }
        if self.temperature is not None:
            payload["temperature"] = self.temperature
        if self.max_tokens is not None:
            payload["max_tokens"] = self.max_tokens
        if stop:
            payload["stop"] = stop

        result = self.client.call(payload, path=self.path)
        if not result["success"]:
            raise RuntimeError(result["error"])

        content = result["response"]["choices"][0]["message"]["content"]
        generation = ChatGeneration(message=AIMessage(content=content))
        return ChatResult(generations=[generation], llm_output={"x402": result.get("receipt")})

