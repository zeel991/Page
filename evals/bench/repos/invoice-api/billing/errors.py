class InvariantError(Exception):
    """A value the service computed is impossible; the request fails rather than bill it."""


def invariant(condition, message):
    if not condition:
        raise InvariantError(message)
