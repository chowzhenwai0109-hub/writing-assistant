"""Public LLM failures contain only controlled messages, never provider details."""


class LLMError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class LLMFailure(LLMError):
    def __init__(self, detail: str = "Writing assistance failed. Please retry."):
        super().__init__(502, detail)


class LLMUnavailable(LLMError):
    def __init__(self, detail: str):
        super().__init__(503, detail)


class LLMTimeout(LLMError):
    def __init__(self):
        super().__init__(504, "Writing assistance timed out. Please retry.")
