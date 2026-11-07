// Off-chain SEP-53 signatures for test_stellar_holder.cairo, made by
// js-stellar-sdk 17.4.0: Keypair.fromRawEd25519Seed(32 x 0x07)
// .signMessage("Veil authorization\n0x" + 64 hex of the hash). Felts are
// [pk.low, pk.high, R.low, R.high, S.low, S.high], each 32 bytes big-endian.

pub fn table() -> Array<(felt252, Array<felt252>)> {
    array![
        (0x1871a138afe7fc1256bfc11180447fd85294f0258bbfb01007ad6430569a01f, array![0x954776aebebe7b92421eea691446d22c, 0xea4a6c63e29c520abef5507b132ec5f9, 0xb93aa4faef767f31e73804c786a9e1dd, 0xfd90df9c9c6b1feebca8e7409a62ac2c, 0x24e28addca72466100e8ef2e2a685502, 0xd86e4a7a347777d261e92c66454d9383]),
        (0x496dd738b6a5526022e4653ed3cf1d9fa170f0d2cf2ed80751ab4de81bdcf89, array![0x954776aebebe7b92421eea691446d22c, 0xea4a6c63e29c520abef5507b132ec5f9, 0x4225b26f154a40667ed02ab2b925f7aa, 0xcc26add330cd28840574304e8fc8e9ef, 0x862887bdcd403bf25b65a8beb4ee200d, 0x6acebefa49b8aa1f0e250e79b9d788fd]),
        (0x3caf9987589341c2e69fb43c54046b6f258fceeffdc90edac181dac83b0b3f4, array![0x954776aebebe7b92421eea691446d22c, 0xea4a6c63e29c520abef5507b132ec5f9, 0x854e6139969ae876fbbfd6064f85d750, 0x8b97d71c2afddab42b5b3ea4d38e25bb, 0xc565f4bbde126fe0831597d51a726500, 0x7730ae2e8f5a0afce729428ccd938e37]),
        (0x40e3905369ea8351ea1a40954c3b7b8b96825c98c8b1ccad279eff7ca5d151e, array![0x954776aebebe7b92421eea691446d22c, 0xea4a6c63e29c520abef5507b132ec5f9, 0xa49478a693fed818f6a725f1e7b9a3e5, 0x6a81842f25d2cd2fcf981a1d732d4531, 0x5188ac1426757332cbddb002669d2506, 0x1edda446f0be4a12a9698c1b9ef31a8f]),
        (0x41b3a0ad7f32e6ee18e91b8d0d343d40bef2ce2eb858e49c91d0ea7d48ca622, array![0x954776aebebe7b92421eea691446d22c, 0xea4a6c63e29c520abef5507b132ec5f9, 0xa232277a2dd9f21358e6c7f4904b5279, 0x0dedb54b624ebe6ee1fe31f59af6449b, 0x1bfa8de3f3a8a62300cfaa98196ce402, 0xe3cbe4829547c3b944ca18d7cb2840af]),
        (0x750322974567edc1e4ac079a16885861d643098effd1764a766d76a84967ff3, array![0x954776aebebe7b92421eea691446d22c, 0xea4a6c63e29c520abef5507b132ec5f9, 0xa967c93d94e76dfe3cad6d72957eabc3, 0x772ed4171c7eb61c0ba6a1e9c9fca291, 0x39f814976c638100cf62d14822314b0b, 0xc6f2975303b9c37650dfc2034bd15c05]),
    ]
}

pub fn stellar_sig(hash: felt252) -> Array<felt252> {
    for (h, sig) in table() {
        if h == hash {
            return sig;
        }
    }
    println!("STELLAR_VECTOR_MISSING {hash}");
    panic!("no stellar vector")
}

/// The same hashes signed by the OTHER key (seed 32 x 0x09).
pub fn other_key_sig(hash: felt252) -> Array<felt252> {
    if hash == 0x4c2623840206d3829c9b35d84cbc163e55e66196c3c627a698f2c053185f954 {
        return array![0x91fdebf76b13c58ed702eac835e9f618, 0xfd1724385aa0c75b64fb78cd602fa1d9, 0x31ebb12a16548a7808e80587fa35fd89, 0x84ee8fb72ad679da94f29555edf9ad2c, 0x0edc76d971881cb22e6bf95666bfbd0e, 0x3378b054f2499abe0e53f2a95ec29f6f];
    }
    if hash == 0x50dbb01bd6f834165955b0e0b1dfdccac23556368790d4c150ba30971cec4f1 {
        return array![0x91fdebf76b13c58ed702eac835e9f618, 0xfd1724385aa0c75b64fb78cd602fa1d9, 0xdfa9bada905a57bdafb376420d0a2142, 0x21bb150d8a4ba1f6ca1c19aa2d2411ff, 0x88ed944917382ca74d32831b00a11101, 0x3e1e838b26e6a402be49cb7512343de7];
    }
    println!("OTHER_VECTOR_MISSING {hash}");
    panic!("no other-key vector")
}
