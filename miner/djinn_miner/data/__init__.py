"""Sports data providers for the Djinn miner.

The SportsDataProvider protocol defines the interface. OddsApiClient is
the default implementation. Custom providers can be loaded by setting
SPORTS_DATA_PROVIDER to a module path (e.g. "my_module.MyProvider").
"""

from djinn_miner.data.provider import BookmakerOdds, SportsDataProvider

__all__ = ["BookmakerOdds", "SportsDataProvider"]
