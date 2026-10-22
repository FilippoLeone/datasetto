/**
 * The Drowned Bellhouse: 13 rooms on a 4 × 5 grid (bellwick.md §1.6). Room n has id 31 + n. Keys A and C
 * come before the Vinehook and fit L1 and L2 in either order; key B and L3 are behind the hook.
 */
export default String.raw`
@screen 32 entry 1,4 dungeon bellhouse
%%%%%::%%%%%
%::::::::::%
%:L::::::::%
%::::::::::%
::::::::::::
::::::::::::
%::::::::::%
%::::::::::%
%%%%%::%%%%%
@lantern 2,2 entry
@exit s shore 6,3
@enemy burrlet 4,6
@enemy burrlet 8,3

@screen 33 cistern 0,4 dungeon bellhouse
%%%%%%%%%%%%
%::::::::::%
%:~~~~~~~~:%
%:~~~~~~~~:%
%:::::::::::
%:::::::::::
%:C::::::::%
%::::::::::%
%%%%%%%%%%%%
@chest 2,6 key flag=key_a
@enemy snapjaw 8,5
@enemy snapjaw 3,7

@screen 34 stair 2,4 dungeon bellhouse
%%%%%%%%%%%%
%::::::::%%%
%:::%%%::%%%
%::::::::::%
:::::::::::%
:::::::::::%
%::::::::::%
%::::B:::::%
%%%%%%%%%%%%
@chest 5,7 map flag=chest_map under=block
@enemy bat 3,1
@enemy bat 8,3
@enemy bat 2,6

@screen 35 nave 1,3 dungeon bellhouse
%%%%%kk%%%%%
%::::::::::%
%:%::::::%:%
%::::::::::%
:::::::::::k
:::::::::::k
%:%::::::%:%
%::::::::::%
%%%%%::%%%%%
@lock 5,0 flag=lock_l2
@lock 6,0 flag=lock_l2
@lock 11,4 flag=lock_l1
@lock 11,5 flag=lock_l1
@enemy burrlet 3,3
@enemy burrlet 8,3
@enemy burrlet 5,6
@enemy slingkin 8,7

@screen 36 chapel 0,3 dungeon bellhouse
%%%%%%%%%%%%
%::%::::%::%
%::::::::::%
%::::::::::%
%:::::::::::
%:::::::::::
%::::::::::%
%::%::::%::%
%%%%%%%%%%%%
@chest 5,2 key flag=key_c appear=clear
@enemy shellback 4,4 r
@enemy shellback 7,5 l

@screen 37 gallery 2,3 dungeon bellhouse
%%%%%%%%%%%%
%::::::::::%
%:::_::_:::%
%::::::::::%
::::B::B:::X
:::::::::::X
%::::::::::%
%::C:::::::%
%%%%%%%%%%%%
@shutter flag=gallery_open
@chest 3,7 compass flag=chest_compass

@screen 38 vault 3,3 dungeon bellhouse
%%%%+::%%%%%
%::::::::::%
%OOOOOOOOOO%
%OOOOOOOOOO%
:::::::::::%
:::::::+:::%
%::::::::::%
%:::::C::::%
%%%%%%%%%%%%
@chest 6,7 hook flag=chest_hook
@enemy wisp 3,6
@enemy wisp 8,3

@screen 39 ropehall 1,2 dungeon bellhouse
%%%%%::%%%%%
%::::::::::%
%::+:::::::k
%::::::::::k
%OOOOOOOOOO%
%OOOOOOOOOO%
:::::::::::%
::::::::+::%
%%%%%::%%%%%
@lock 11,2 flag=lock_l3
@lock 11,3 flag=lock_l3
@enemy bat 9,1

@screen 40 ossuary 0,2 dungeon bellhouse
%%%%%%%%%%%%
%:::::::::C%
%:%%:::%%::%
%::::::::::%
%:%%:::%%::%
%::::::::::%
%:::::::::::
%:::::::::::
%%%%%%%%%%%%
@chest 10,1 shard flag=shard_ossuary
@enemy rootling 3,3
@enemy rootling 7,5
@enemy rootling 9,2

@screen 41 clockwork 2,2 dungeon bellhouse
%%%%%%%%%%%%
%::::::OOO:%
:::::::OOOC%
:::::::OOO:%
%::::::bbb:%
%::::::OOO:%
%::::::OOOc%
%::::::OOO:%
%%%%%%%%%%%%
@crystal 10,6 flag=clock_bridge
@chest 10,2 bosskey flag=chest_bosskey
@enemy slingkin 2,6
@enemy slingkin 4,1

@screen 42 crypt 3,2 dungeon bellhouse
%%%%%%%%%%%%
%:C:%%%%:C:%
%::+~~~~+::%
%:::~~~~:::%
%~~~~~~~~~~%
%~~~~~~~~~~%
%::::::::::%
%::+::::+::%
%%%%%::%%%%%
@chest 2,1 key flag=key_b
@chest 9,1 shard flag=shard_crypt
@enemy rootling 1,3
@enemy rootling 10,3

@screen 43 ante 1,1 dungeon bellhouse
%%%%%KK%%%%%
%::::::::::%
%:p::::::p:%
%::::::::::%
%:L:::::::p%
%::::::::::%
%::::::::::%
%::::::::::%
%%%%%::%%%%%
@lock 5,0 flag=boss_door
@lock 6,0 flag=boss_door
@lantern 2,4 ante

@screen 44 belfry 1,0 dungeon boss
%%%%%%%%%%%%
%::::::::::%
%::::::::::%
%::::::::::%
%::::::::::%
%::::::::::%
%::::::::::%
%::::::::::%
%%%%%::%%%%%
@boss 6,3
`;
