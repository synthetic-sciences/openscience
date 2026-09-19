"""
KEGG REST API Helper Functions

This module provides Python functions for interacting with the KEGG REST API.
All functions return raw response text which can be parsed as needed.

API Base URL: https://rest.kegg.jp
Documentation: https://www.kegg.jp/kegg/rest/keggapi.html

IMPORTANT: KEGG API is made available only for academic use by academic users.
"""

import urllib.request
import urllib.parse
import urllib.error
from typing import Optional, List, Union


KEGG_BASE_URL = "https://rest.kegg.jp"


def kegg_info(database: str) -> str:
    """
    Get database metadata and statistics.

    Args:
        database: KEGG database name (e.g., 'kegg', 'pathway', 'enzyme', 'genes')

    Returns:
        str: Database information and statistics

    Example:
        info = kegg_info('pathway')
    """
    url = f"{KEGG_BASE_URL}/info/{database}"
    try:
        with urllib.request.urlopen(url) as response:
            return response.read().decode('utf-8')
    except urllib.error.HTTPError as e:
        return f"Error: {e.code} - {e.reason}"


def kegg_list(database: str, org: Optional[str] = None) -> str:
    """
    List entry identifiers and associated names.

    Args:
        database: KEGG database name or specific entry (e.g., 'pathway', 'enzyme', 'hsa:10458')
        org: Optional organism code for pathway/module listings (e.g., 'hsa' for human)

    Returns:
        str: Tab-delimited list of entries

    Examples:
        pathways = kegg_list('pathway')  # List all reference pathways
        hsa_pathways = kegg_list('pathway', 'hsa')  # List human pathways
        genes = kegg_list('hsa:10458+ece:Z5100')  # List specific genes
    """
    if org:
        url = f"{KEGG_BASE_URL}/list/{database}/{org}"
    else:
        url = f"{KEGG_BASE_URL}/list/{database}"

    try:
        with urllib.request.urlopen(url) as response:
            return response.read().decode('utf-8')
    except urllib.error.HTTPError as e:
        return f"Error: {e.code} - {e.reason}"


def kegg_find(database: str, query: str, option: Optional[str] = None) -> str:
    """
    Search for entries by keywords or molecular properties.

    Args:
        database: Database to search ('genes', 'compound', 'drug', etc.)
        query: Search term or molecular property
        option: Optional parameter for molecular searches:
                'formula' - exact match to chemical formula
                'exact_mass' - range search by exact mass (e.g., '174.05-174.15')
                'mol_weight' - range search by molecular weight

    Returns:
        str: Tab-delimited search results

    Examples:
        # Keyword search
        results = kegg_find('genes', 'shiga toxin')

        # Formula search
        compounds = kegg_find('compound', 'C7H10N4O2', 'formula')

        # Mass range search
        drugs = kegg_find('drug', '300-310', 'exact_mass')
    """
    query_encoded = urllib.parse.quote(query)

    if option:
        url = f"{KEGG_BASE_URL}/find/{database}/{query_encoded}/{option}"
    else:
        url = f"{KEGG_BASE_URL}/find/{database}/{query_encoded}"

    try:
        with urllib.request.urlopen(url) as response:
            return response.read().decode('utf-8')
    except urllib.error.HTTPError as e:
        return f"Error: {e.code} - {e.reason}"










if __name__ == "__main__":
    # Example usage
    print("KEGG Info Example:")
    print(kegg_info('pathway')[:200] + "...\n")

    print("KEGG List Example (first 3 pathways):")
    pathways = kegg_list('pathway')
    print('\n'.join(pathways.split('\n')[:3]) + "\n")

    print("KEGG Find Example:")
    print(kegg_find('genes', 'p53')[:200] + "...")
